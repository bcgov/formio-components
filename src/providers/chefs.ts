/**
 * CHEFS storage provider for Form.io's fileService. Opt-in: the host registers it
 * and passes filesUrl + a token getter (workspace/submission ids optional).
 *
 *   Formio.Providers.addProvider('storage', 'chefs', createChefsProvider({
 *     filesUrl: `${getSobaApiBaseUrl()}/files`,
 *     getToken: () => currentBearerToken(),
 *     getWorkspaceId: () => currentWorkspaceId(),
 *   }));
 *
 * Per-file URLs are {filesUrl}/{id}, so upload only needs to return { id, name, size, type }.
 *
 *   Upload:   POST   {filesUrl}?workspaceId=<id>  (multipart: <fileKey>, fileName, submissionId?, dir?)
 *   Download: GET    {filesUrl}/{id}
 *   Delete:   DELETE {filesUrl}/{id}
 *   ...all with `Authorization: Bearer <token>`.
 */

/** Static value, or a sync/async getter for it. */
type Resolvable = string | (() => string | Promise<string>);

export interface ChefsProviderConfig {
  /** Files collection URL — absolute or same-origin, e.g. 'https://host/api/v1/files' or '/api/v1/files'. */
  filesUrl: Resolvable;
  /** Current bearer token (raw, no 'Bearer ' prefix). Read per request. */
  getToken: Resolvable;
  /** Current workspace id — added as ?workspaceId= on upload when set. */
  getWorkspaceId?: Resolvable;
  /** Current CHEFS submission id (the owning resource) — sent as submissionId when set. */
  getSubmissionId?: Resolvable;
  /** Extra request headers, beyond Authorization. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Multipart field name for the file name. Default 'fileName'. */
  fileNameField?: string;
  /** Multipart field name for the directory. Default 'dir'. */
  dirField?: string;
  /** Multipart field name for the submission id. Default 'submissionId'. */
  submissionField?: string;
  /** Query param name for the workspace id. Default 'workspaceId'. */
  workspaceParam?: string;
}

// Give an opened tab time to read the blob before revoking its object URL.
const OBJECT_URL_TTL_MS = 60000;

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/** Resolve a static value or getter to a string ('' when absent). */
const resolveValue = async (value?: Resolvable): Promise<string> => {
  if (typeof value === 'function') {
    return (await value()) || '';
  }
  return value || '';
};

/**
 * POST a multipart body over XHR (fetch can't report upload progress or abort).
 * Resolves the parsed JSON; rejects with an Error. Abort is tagged so File.js
 * shows its "aborted" message.
 */
const xhrPost = (
  url: string,
  body: FormData,
  requestHeaders: Record<string, string>,
  progressCallback: any,
  abortCallback: any,
): Promise<any> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (xhr.upload && typeof progressCallback === 'function') {
      xhr.upload.onprogress = progressCallback;
    }
    if (typeof abortCallback === 'function') {
      abortCallback(() => xhr.abort());
    }
    xhr.open('POST', url);
    Object.keys(requestHeaders).forEach((name) => xhr.setRequestHeader(name, requestHeaders[name]));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText || '{}'));
        } catch {
          resolve({});
        }
      } else {
        reject(new Error(xhr.responseText || `Upload failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error.'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload was aborted.'), { type: 'abort' }));
    xhr.send(body);
  });

export function createChefsProvider(config: ChefsProviderConfig) {
  const {
    filesUrl,
    getToken,
    getWorkspaceId,
    getSubmissionId,
    headers,
    fileNameField = 'fileName',
    dirField = 'dir',
    submissionField = 'submissionId',
    workspaceParam = 'workspaceId',
  } = config || ({} as ChefsProviderConfig);

  if (!filesUrl || !getToken) {
    throw new Error('createChefsProvider requires filesUrl and getToken.');
  }

  // Files base, no trailing slash (may be relative).
  const collectionUrl = async (): Promise<string> => trimTrailingSlash(await resolveValue(filesUrl));

  // Auth + any extra headers; the token's Authorization wins.
  const buildHeaders = async (token: string): Promise<Record<string, string>> => {
    const extra = headers ? (await headers()) || {} : {};
    return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
  };

  // {base}/{id} — uploads always come back with an id.
  const fileUrl = (base: string, file: any): string => {
    if (!file || file.id == null) {
      throw new Error('Cannot resolve file URL: the file has no id.');
    }
    return `${base}/${encodeURIComponent(file.id)}`;
  };

  const uploadFile = async (...args: any[]) => {
    // Form.io calls uploadFile positionally:
    // 0 file, 1 fileName, 2 dir, 3 progressCallback, 4 url, 5 options,
    // 6 fileKey, 7 groupPermissions, 8 groupId, 9 abortCallback, 10 multipartOptions
    const [file, fileName, dir, progressCallback, , , fileKey, , , abortCallback] = args;

    const [base, token, workspaceId, submissionId] = await Promise.all([
      collectionUrl(),
      resolveValue(getToken),
      resolveValue(getWorkspaceId),
      resolveValue(getSubmissionId),
    ]);

    const separator = base.includes('?') ? '&' : '?';
    const uploadUrl = workspaceId
      ? `${base}${separator}${workspaceParam}=${encodeURIComponent(workspaceId)}`
      : base;

    const body = new FormData();
    body.append(fileKey || 'file', file, file.name);
    body.append(fileNameField, fileName);
    if (dir) {
      body.append(dirField, dir);
    }
    if (submissionId) {
      body.append(submissionField, submissionId);
    }

    const requestHeaders = await buildHeaders(token);
    const response = await xhrPost(uploadUrl, body, requestHeaders, progressCallback, abortCallback);
    if (response.id == null) {
      throw new Error('Upload response did not include a file id.');
    }

    return {
      storage: 'chefs',
      id: response.id,
      name: response.name || fileName,
      originalName: response.originalName || file.name,
      url: `${base}/${encodeURIComponent(response.id)}`,
      size: response.size != null ? response.size : file.size,
      type: response.type || file.type,
    };
  };

  const downloadFile = async (file: any) => {
    const [base, token] = await Promise.all([collectionUrl(), resolveValue(getToken)]);
    const response = await fetch(fileUrl(base, file), { method: 'GET', headers: await buildHeaders(token) });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(detail || `Unable to download file (${response.status}).`);
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    setTimeout(() => URL.revokeObjectURL(objectUrl), OBJECT_URL_TTL_MS);
    return { ...file, url: objectUrl };
  };

  const deleteFile = async (file: any) => {
    const [base, token] = await Promise.all([collectionUrl(), resolveValue(getToken)]);
    const response = await fetch(fileUrl(base, file), { method: 'DELETE', headers: await buildHeaders(token) });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(detail || `Unable to delete file (${response.status}).`);
    }
    return 'File deleted';
  };

  // Regular function, not an arrow: Form.io calls `new Provider(this)`.
  const chefs = function chefs() {
    return { title: 'CHEFS', name: 'chefs', uploadFile, downloadFile, deleteFile };
  };
  // Label for the component's Storage dropdown.
  return Object.assign(chefs, { title: 'CHEFS' });
}

export default createChefsProvider;
