/* tslint:disable */
import { Components, Utils } from '@formio/js';
import editForm from './BCGovFile.form';
import { Constants } from '../Common/Constants';

// Defensively access components in case @formio/js is mocked/stubbed in SSR
const baseFile = (Components as any)?.components?.file;
const ParentComponent = baseFile || class {
  static schema(...extend: any[]) {
    return Object.assign({}, ...extend);
  }
};
const uniqueName = Utils?.uniqueName || ((name: string) => name);

const ID = 'bcgov-file';
const DISPLAY = 'File Upload';

function remSlash(s: string) {
  if (!s) return '';
  let result = s.trim();
  while (result.startsWith('/')) result = result.slice(1);
  while (result.endsWith('/')) result = result.slice(0, -1);
  return result;
}

function buildUrlPath(...segments: string[]) {
  return (
    '/' +
    segments
      .map((segment) => remSlash(segment))
      .filter(Boolean)
      .join('/')
  );
}

export default class BCGovFile extends ParentComponent {
  static schema(...extend) {
    return ParentComponent.schema(
      {
        type: ID,
        label: DISPLAY,
        key: ID,
        storage: 'chefs',
        url: '/api/v1/files/local-storage',
        fileKey: 'files',
        fileNameTemplate: '{{fileName}}',
        image: false,
        webcam: false,
        webcamSize: 320,
        privateDownload: false,
        imageSize: '200',
        filePattern: '',
        fileMinSize: '0KB',
        fileMaxSize: '1GB',
        uploadOnly: false,
        customClass: 'formio-component-file',
      },
      ...extend
    );
  }

  public static readonly editForm = editForm;

  static get builderInfo() {
    return {
      title: DISPLAY,
      group: 'basic',
      icon: 'file',
      weight: 13,
      documentation: Constants.DEFAULT_HELP_LINK,
      schema: BCGovFile.schema(),
    };
  }

  // we will read these in from runtime
  private readonly _enabled: boolean;

  constructor(...args) {
    super(...args);
    if (this.options?.componentOptions) {
      const opts = this.options.componentOptions[ID];
      this.component.options = { ...this.component.options, ...opts };
      // the config.uploads object will say what size our server can handle and what path to use.
      if (opts?.config?.uploads) {
        const cfg = opts.config;
        const uploads = cfg.uploads;

        this.component.fileMinSize = uploads.fileMinSize;
        this.component.fileMaxSize = uploads.fileMaxSize;
        // Only set the default url from global config if one is not already provided by the user/schema
        if (!this.component.url || this.component.url === '/files') {
          if (uploads.webcomponents && uploads.url) {
            this.component.url = uploads.url;
          } else {
            this.component.url = buildUrlPath(cfg.basePath, cfg.apiPath, uploads.path);
          }
        }
        this._enabled = uploads.enabled;
      }
    }
  }

  /**
   * Delete a file by calling DELETE {baseUrl}/{fileId} with Authorization header.
   */
  async delete() {
    if (!this.filesToSync?.filesToDelete?.length) {
      return Promise.resolve();
    }
    return await Promise.all(
      this.filesToSync.filesToDelete.map(async (fileToSync: any) => {
        try {
          if (fileToSync.isValidationError) {
            return { fileToSync };
          }
          const fileId = fileToSync?.data?.id ?? fileToSync.id;
          if (fileId) {
            const opts = this.component.options ?? {};
            let token = opts.token || opts.bearerToken || this.options?.token || '';
            try {
              const F = (typeof window !== 'undefined' ? (window as any).Formio : undefined) || (globalThis as any).Formio;
              if (!token && F) {
                token = (typeof F.getToken === 'function' && F.getToken()) || token;
                token = token || (F?.tokens?.accessToken ?? F?.token ?? '');
                token = token || (F?.currentUser?.token ?? '');
              }
            } catch (e) {}

            const baseUrl = this.interpolate(this.component.url);
            const url = `${baseUrl}/${fileId}`;

            const res = await fetch(url, {
              method: 'DELETE',
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            if (!res.ok) {
              const text = await res.text();
              throw { status: res.status, detail: text };
            }
          }

          fileToSync.status = 'success';
          fileToSync.message = this.t('Successfully removed');
        } catch (response: any) {
          fileToSync.status = 'error';
          fileToSync.message = typeof response === 'string' ? response : response.toString();
        } finally {
          this.redraw();
        }
        return { fileToSync };
      })
    );
  }

  async upload() {
    if (!this.filesToSync?.filesToUpload?.length) {
      return Promise.resolve();
    }
    return await Promise.all(
      this.filesToSync.filesToUpload.map(async (fileToSync: any) => {
        let fileInfo: any = null;
        try {
          if (fileToSync.isValidationError) {
            return { fileToSync, fileInfo };
          }

          fileInfo = await new Promise((resolveUpload, rejectUpload) => {
            const file = fileToSync.file;
            const fileName = fileToSync.name;
            const dir = fileToSync.dir;

            const url = this.interpolate(this.component.url);
            const fileKey = this.component.fileKey ?? 'file';

            const formData = new FormData();
            formData.append(fileKey, file, file.name);
            formData.append('fileName', fileName);
            if (dir) formData.append('dir', dir);

            const opts = this.component.options ?? {};
            let token = opts.token || opts.bearerToken || this.options?.token || '';
            try {
              const F = (typeof window !== 'undefined' ? (window as any).Formio : undefined) || (globalThis as any).Formio;
              if (!token && F) {
                token = (typeof F.getToken === 'function' && F.getToken()) || token;
                token = token || (F?.tokens?.accessToken ?? F?.token ?? '');
                token = token || (F?.currentUser?.token ?? '');
              }
            } catch (e) {}
            const formId = this.root?.form?._id ?? this.root?.form?.id ?? opts.formId ?? this.options?.formId ?? '';
            const submissionId = this.root?.submission?._id ?? this.root?.submission?.id ?? opts.submissionId ?? this.options?.submissionId ?? '';
            if (formId) formData.append('formId', formId);
            if (submissionId) formData.append('submissionId', submissionId);

            const xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  const response = JSON.parse(xhr.responseText || '{}');
                  const data = response?.data ?? response ?? {};
                  const id = data.id ?? data._id ?? data.fileId ?? data.id;

                  const info: any = {
                    id,
                    storage: this.component.storage,
                    name: fileName,
                    url: `${url}/${id}`,
                    size: file.size,
                    type: file.type,
                    originalName: file.name,
                    data: response,
                  };

                  const returnedSubmissionId = data.submissionId ?? data.submission?._id ?? null;
                  if (returnedSubmissionId) {
                    this.root = this.root || {};
                    this.root.submission = this.root.submission || {};
                    this.root.submission._id = returnedSubmissionId;
                  }

                  resolveUpload(info);
                } catch (e) {
                  resolveUpload({});
                }
              } else {
                rejectUpload({ status: xhr.status, detail: xhr.responseText });
              }
            };

            xhr.onerror = () => {
              rejectUpload({ status: xhr.status, detail: xhr.responseText });
            };

            if (xhr.upload) {
              xhr.upload.onprogress = (evt) => {
                if (evt.lengthComputable && typeof this.updateProgress === 'function') {
                  this.updateProgress(fileToSync, evt);
                }
              };
            }

            if (this.abortUploads) {
              this.abortUploads.push({
                id: fileToSync.id,
                abort: () => xhr.abort(),
              });
            }

            xhr.send(formData);
          });

          fileToSync.status = 'success';
          fileToSync.message = this.t('Successfully uploaded');
          if (fileInfo) {
            fileInfo.originalName = fileToSync.originalName;
            fileInfo.hash = fileToSync.hash;
          }
        } catch (response: any) {
          fileToSync.status = 'error';
          delete fileToSync.progress;
          let message = 'An unexpected error occured during file upload.';
          if (response?.status) {
            const detail = response.detail || '';
            if (response.status === 409 || detail.includes('409')) message = 'File did not pass the virus scanner.';
            else if (response.status === 400 || detail.includes('400')) message = 'File could not be uploaded.';
            else message = `Error ${response.status}: ${detail || 'Unknown error'}`;
          } else {
            message = typeof response === 'string' ? response : response.type === 'abort' ? this.t('Request was aborted') : response.toString();
          }
          fileToSync.message = this.t(message);
          this.emit('fileUploadError', { fileToSync, response });
        } finally {
          delete fileToSync.progress;
          this.redraw();
        }
        return { fileToSync, fileInfo };
      })
    );
  }

  /**
   * Get a file by calling GET {baseUrl}/{fileId} with Authorization header and downloading the blob.
   */
  getFile(fileInfo: any) {
    const fileId = fileInfo?.data?.id ?? fileInfo.id;
    if (!fileId) return Promise.resolve();

    const opts = this.component.options ?? {};
    let token = opts.token || opts.bearerToken || this.options?.token || '';
    try {
      const F = (typeof window !== 'undefined' ? (window as any).Formio : undefined) || (globalThis as any).Formio;
      if (!token && F) {
        token = (typeof F.getToken === 'function' && F.getToken()) || token;
        token = token || (F?.tokens?.accessToken ?? F?.token ?? '');
        token = token || (F?.currentUser?.token ?? '');
      }
    } catch (e) {
      // ignore
    }
    const baseUrl = this.interpolate(this.component.url);
    const url = `${baseUrl}/${fileId}`;

    return fetch(url, { method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((res) => {
        if (!res.ok) return res.text().then((t) => Promise.reject({ status: res.status, detail: t }));
        return res.blob();
      })
      .then((blob) => {
        try {
          const downloadUrl = URL.createObjectURL(blob);
          if (typeof document !== 'undefined') {
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = fileInfo.originalName || fileInfo.name || 'file';
            document.body.appendChild(a);
            a.click();
            a.remove();
          }
          URL.revokeObjectURL(downloadUrl);
        } catch (err) {
          const blobUrl = URL.createObjectURL(blob);
          if (typeof window !== 'undefined') {
            window.open(blobUrl, '_blank');
          }
          URL.revokeObjectURL(blobUrl);
        }
      })
      .catch((error_) => {
        // eslint-disable-next-line no-console
        console.error('Get file error', error_);
        alert(this.t('An error occurred while fetching the file.'));
        return Promise.reject(error_);
      });
  }
}