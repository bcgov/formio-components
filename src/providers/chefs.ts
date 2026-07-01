/* tslint:disable */
/**
 * CHEFS storage provider for Form.io's pluggable fileService.
 *
 * This is an *opt-in* provider: it is NOT registered automatically by the
 * components package. A host application registers it explicitly and injects
 * its own runtime specifics (API base URL, bearer token, workspace + submission id):
 *
 *   import { Formio } from '@formio/js';
 *   import { createChefsProvider } from '@bcgov/formio-components';
 *
 *   Formio.Providers.addProvider('storage', 'chefs', createChefsProvider({
 *     apiBase: '',                                   // '' = same-origin
 *     filesPath: '/api/v1/files',                    // files collection endpoint
 *     getToken:        () => keycloak.updateToken(30).then(() => keycloak.token),
 *     getWorkspaceId:  async () => sessionStorage.getItem('soba.workspaceId'),
 *     getSubmissionId: async () => sessionStorage.getItem('soba.submissionId'),
 *   }));
 *
 * A BCGovFile component with `storage: 'chefs'` then routes upload/download/
 * delete through this provider via `this.fileService`. The component itself
 * contains no tokens, tenant ids, or fixed URLs.
 *
 * Backend contract (with the default filesPath):
 *   Upload:   POST   {apiBase}{filesPath}?workspaceId=<id>   (multipart)
 *             fields: <fileKey> (default 'file'), fileName, submissionId (the
 *                     owning CHEFS resource, from getSubmissionId), optional dir
 *             header: Authorization: Bearer <token>
 *             response: { id, storage, name, originalName,
 *                         url: '{filesPath}/<id>', size, type, data }
 *   Download: GET    {apiBase}{url} + Authorization: Bearer <token>  -> bytes
 *   Delete:   DELETE {apiBase}{url} + Authorization: Bearer <token>  -> 204
 */

export interface ChefsProviderConfig {
  /** Absolute base URL of the files API pod, or '' for same-origin. */
  apiBase?: string;
  /** Files collection endpoint path used for uploads. Defaults to '/api/v1/files'. */
  filesPath?: string;
  /** Returns the current bearer token; evaluated per-request so it never goes stale. */
  getToken: () => string | Promise<string>;
  /** Returns the current workspace id; appended to the upload URL as ?workspaceId=. */
  getWorkspaceId: () => string | Promise<string>;
  /**
   * Returns the current CHEFS submission id — the resource the uploaded file
   * belongs to. This is the app's own submission id, NOT Form.io's data
   * submission id. Sent as the `submissionId` upload field when present.
   */
  getSubmissionId?: () => string | Promise<string>;
}

const trimTrailingSlash = (s: string) => String(s || '').replace(/\/+$/, '');
// Normalize to a leading-slash, no-trailing-slash path (e.g. 'api/v1/files/' -> '/api/v1/files').
const normalizePath = (s: string) => `/${String(s || '').replace(/^\/+/, '').replace(/\/+$/, '')}`;

export function createChefsProvider(config: ChefsProviderConfig) {
  const {
    apiBase = '',
    filesPath = '/api/v1/files',
    getToken,
    getWorkspaceId,
    getSubmissionId,
  } = config || ({} as ChefsProviderConfig);

  if (typeof getToken !== 'function' || typeof getWorkspaceId !== 'function') {
    throw new Error('createChefsProvider requires getToken() and getWorkspaceId() functions.');
  }

  const collectionPath = normalizePath(filesPath);

  // Resolve an app-relative file url (e.g. '/api/v1/files/<id>') against apiBase.
  const resolveUrl = (url: string) => `${trimTrailingSlash(apiBase)}${url}`;

  const authHeaders = (token: string) =>
    token ? { Authorization: `Bearer ${token}` } : {};

  const chefs = function chefs(formio: any) {
    return {
      title: 'CHEFS',
      name: 'chefs',

      async uploadFile(
        file: any,
        fileName: string,
        dir: string,
        progressCallback: any,
        _url: string,
        _options: any,
        fileKey: string,
        _groupPermissions: any,
        _groupId: any,
        abortCallback: any,
      ) {
        const [token, workspaceId, submissionId] = await Promise.all([
          Promise.resolve(getToken()),
          Promise.resolve(getWorkspaceId()),
          getSubmissionId ? Promise.resolve(getSubmissionId()) : Promise.resolve(''),
        ]);

        let uploadUrl = `${trimTrailingSlash(apiBase)}${collectionPath}`;
        if (workspaceId) {
          uploadUrl += `?workspaceId=${encodeURIComponent(workspaceId)}`;
        }

        return await new Promise((resolve, reject) => {
          const formData = new FormData();
          formData.append(fileKey || 'file', file, file.name);
          formData.append('fileName', fileName);
          if (dir) {
            formData.append('dir', dir);
          }
          // The CHEFS submission id (owning resource) supplied by getSubmissionId.
          if (submissionId) {
            formData.append('submissionId', submissionId);
          }

          const xhr = new XMLHttpRequest();
          if (xhr.upload && typeof progressCallback === 'function') {
            xhr.upload.onprogress = progressCallback;
          }
          if (typeof abortCallback === 'function') {
            abortCallback(() => xhr.abort());
          }

          xhr.open('POST', uploadUrl);
          if (token) {
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          }

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              let response: any = {};
              try {
                response = JSON.parse(xhr.responseText || '{}');
              } catch (e) {
                response = {};
              }
              const id = response.id;
              resolve({
                storage: 'chefs',
                id,
                name: response.name || fileName,
                originalName: response.originalName || file.name,
                // Keep the app-relative url the backend returns; it is resolved
                // against apiBase at download/delete time so apiBase can change.
                url: response.url || `${collectionPath}/${id}`,
                size: response.size != null ? response.size : file.size,
                type: response.type || file.type,
                data: response.data || {},
              });
            } else {
              reject(xhr.responseText || `Unable to upload file (${xhr.status})`);
            }
          };
          xhr.onerror = () => reject(xhr.responseText || 'Unable to upload file');
          xhr.onabort = () => reject({ type: 'abort' });

          xhr.send(formData);
        });
      },

      async downloadFile(file: any) {
        const token = await Promise.resolve(getToken());
        const res = await fetch(resolveUrl(file.url), {
          method: 'GET',
          headers: authHeaders(token),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          return Promise.reject(detail || `Unable to download file (${res.status})`);
        }
        const blob = await res.blob();
        // Hand Form.io a blob object URL it can open / use as an <img> src.
        const objectUrl = URL.createObjectURL(blob);
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
        return { ...file, url: objectUrl };
      },

      async deleteFile(file: any) {
        const token = await Promise.resolve(getToken());
        const res = await fetch(resolveUrl(file.url), {
          method: 'DELETE',
          headers: authHeaders(token),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          return Promise.reject(detail || `Unable to delete file (${res.status})`);
        }
        return 'File deleted';
      },
    };
  };

  // Static title so the component's Storage dropdown shows a friendly label.
  (chefs as any).title = 'CHEFS';
  return chefs;
}

export default createChefsProvider;
