/* tslint:disable */
import { Components, Utils } from '@formio/js';
const ParentComponent = (Components as any).components.file;
import editForm from './BCGovFile.form';

import { Constants } from '../Common/Constants';
import uniqueName = Utils.uniqueName;

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
        url: '/files',
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
        // set the default url to be for uploads.
        if (uploads.webcomponents && uploads.url) {
          this.component.url = uploads.url;
        } else {
          this.component.url = buildUrlPath(cfg.basePath, cfg.apiPath, uploads.path);
        }
        this._enabled = uploads.enabled;
      }
    }
  }

  /**
   * Delete a file by calling DELETE {baseUrl}/{fileId} with Authorization header.
   */
  deleteFile(fileInfo: any) {
    if (!fileInfo) return;
    const fileId = fileInfo?.data?.id ?? fileInfo.id;
    if (!fileId) return;

    const opts = this.component.options ?? {};
    // Token can be provided via component options or via a global Formio auth context.
    let token = opts.token || opts.bearerToken || this.options?.token || '';
    // If not present, try common global Formio accessors as a fallback (defensive).
    try {
      const F = (window as any).Formio || (globalThis as any).Formio;
      if (!token && F) {
        // Formio.getToken() is not guaranteed; check a few places.
        token = (typeof F.getToken === 'function' && F.getToken()) || token;
        token = token || (F?.tokens?.accessToken ?? F?.token ?? '');
        token = token || (F?.currentUser?.token ?? '');
      }
    } catch (e) {
      // ignore
    }
    const baseUrl = this.interpolate(this.component.url);
    const url = `${baseUrl}/${fileId}`;

    fetch(url, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) {
          return res.text().then((t) => Promise.reject({ status: res.status, detail: t }));
        }
        return res.text();
      })
      .then(() => {
        if (this.hasValue()) {
          const id = fileId;
          this.dataValue = (this.dataValue || []).filter((f) => (f?.data?.id ?? f?.id) !== id);
          this.redraw();
          this.triggerChange();
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('Delete file error', err);
        alert(this.t('An error occurred while deleting the file.'));
      });
  }

  /**
   * Upload files by POSTing multipart/form-data to configured endpoint.
   * Includes formId and submissionId when available. Uses XHR to report progress.
   */
  upload(files: FileList | File[] | any) {
    if (!this.component.multiple) {
      files = Array.prototype.slice.call(files, 0, 1);
    }

    if (this.component && files && files.length) {
      Array.prototype.forEach.call(files, (file: File) => {
        const fileName = uniqueName(file.name, this.component.fileNameTemplate, this.evalContext());
        const fileUpload: any = {
          originalName: file.name,
          name: fileName,
          size: file.size,
          status: 'info',
          message: this.t('Starting upload'),
        };

        // Basic security / validation checks (keep existing behavior)
        const fileNameLower = file.name.toLowerCase();
        const systemBlockedExtensions = [
          '.exe', '.bat', '.scr', '.com', '.pif', '.cmd', '.jar', '.app', '.deb', '.dmg', '.msi',
          '.run', '.bin', '.sh', '.ps1', '.vbs', '.js', '.html', '.php', '.py', '.rb',
        ];
        if (systemBlockedExtensions.some((ext) => fileNameLower.endsWith(ext))) {
          fileUpload.status = 'error';
          fileUpload.message = this.t('This file type is not supported for security reasons.');
          this.statuses.push(fileUpload);
          this.redraw();
          return;
        }

        const pattern = this.component.filePattern ?? undefined;
        if (pattern && !this.validatePattern(file, pattern)) {
          fileUpload.status = 'error';
          fileUpload.message = this.t('File type not allowed. Supported: {{ pattern }}', { pattern: this.component.filePattern });
        }

        if (this.component.fileMinSize && !this.validateMinSize(file, this.component.fileMinSize)) {
          fileUpload.status = 'error';
          fileUpload.message = this.t('File is too small; it must be at least {{ size }}', { size: this.component.fileMinSize });
        }

        if (this.component.fileMaxSize && !this.validateMaxSize(file, this.component.fileMaxSize)) {
          fileUpload.status = 'error';
          fileUpload.message = this.t('File is too big; it must be at most {{ size }}', { size: this.component.fileMaxSize });
        }

        const dir = this.interpolate(this.component.dir ?? '');

        this.statuses.push(fileUpload);
        this.redraw();

        if (fileUpload.status === 'error') return;

        if (this.component.privateDownload) (file as any).private = true;

        const url = this.interpolate(this.component.url);
        const fileKey = this.component.fileKey ?? 'file';

        const formData = new FormData();
        // use the File object directly
        formData.append(fileKey, file, file.name);
        formData.append('fileName', fileName);
        if (dir) formData.append('dir', dir);

            const opts = this.component.options ?? {};
            let token = opts.token || opts.bearerToken || this.options?.token || '';
            try {
              const F = (window as any).Formio || (globalThis as any).Formio;
              if (!token && F) {
                token = (typeof F.getToken === 'function' && F.getToken()) || token;
                token = token || (F?.tokens?.accessToken ?? F?.token ?? '');
                token = token || (F?.currentUser?.token ?? '');
              }
            } catch (e) {
              // ignore
            }
        const formId = this.root?.form?._id ?? this.root?.form?.id ?? opts.formId ?? this.options?.formId ?? '';
        const submissionId = this.root?.submission?._id ?? this.root?.submission?.id ?? opts.submissionId ?? this.options?.submissionId ?? '';
        if (formId) formData.append('formId', formId);
        if (submissionId) formData.append('submissionId', submissionId);

        const uploadWithXHR = (uploadUrl_: string, fd: FormData, bearer?: string, onProgress?: (evt: ProgressEvent) => void) => {
          return new Promise<any>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', uploadUrl_);
            if (bearer) xhr.setRequestHeader('Authorization', `Bearer ${bearer}`);
            xhr.onload = function () {
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  resolve(JSON.parse(xhr.responseText || '{}'));
                } catch (e) {
                  resolve({});
                }
              } else {
                reject({ status: xhr.status, detail: xhr.responseText });
              }
            };
            xhr.onerror = function () {
              reject({ status: xhr.status, detail: xhr.responseText });
            };
            if (xhr.upload && typeof onProgress === 'function') xhr.upload.onprogress = onProgress;
            xhr.send(fd);
          });
        };

        uploadWithXHR(url, formData, token, (evt) => {
          fileUpload.status = 'progress';
          if (evt.lengthComputable) fileUpload.progress = (100 * evt.loaded) / evt.total;
          delete fileUpload.message;
          this.redraw();
        })
          .then((response) => {
            const data = response?.data ?? response ?? {};
            const id = data.id ?? data._id ?? data.fileId ?? data.id;
            const originalname = data.originalname ?? data.filename ?? data.name ?? file.name;
            const size = data.size ?? data.filesize ?? file.size;
            const mimetype = data.mimetype ?? data.type ?? file.type;

            const index = this.statuses.indexOf(fileUpload);
            if (index !== -1) this.statuses.splice(index, 1);

            const fileInfo: any = {
              storage: 'chefs',
              name: originalname,
              originalName: file.name,
              url: id ? `${url}/${id}` : `${url}`,
              size,
              type: mimetype,
              data: { id },
            };

            if (!this.hasValue()) this.dataValue = [];
            this.dataValue.push(fileInfo);

            const returnedSubmissionId = data.submissionId ?? data.submission?._id ?? null;
            if (returnedSubmissionId) {
              this.root = this.root || {};
              this.root.submission = this.root.submission || {};
              this.root.submission._id = returnedSubmissionId;
            }

            this.redraw();
            this.triggerChange();
          })
          .catch((error_) => {
            fileUpload.status = 'error';
            let message = 'An unexpected error occured during file upload.';
            const detail = error_?.detail || '';
            const status = error_?.status || 0;
            if (status === 409 || (typeof detail === 'string' && detail.includes('409'))) message = 'File did not pass the virus scanner.';
            else if (status === 400 || (typeof detail === 'string' && detail.includes('400'))) message = 'File could not be uploaded.';
            fileUpload.message = this.t(message);
            delete fileUpload.progress;
            this.redraw();
          });
      });
    }
  }

  /**
   * Get a file by calling GET {baseUrl}/{fileId} with Authorization header and downloading the blob.
   */
  getFile(fileInfo: any) {
    const fileId = fileInfo?.data?.id ?? fileInfo.id;
    if (!fileId) return;

    const opts = this.component.options ?? {};
    let token = opts.token || opts.bearerToken || this.options?.token || '';
    try {
      const F = (window as any).Formio || (globalThis as any).Formio;
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

    fetch(url, { method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((res) => {
        if (!res.ok) return res.text().then((t) => Promise.reject({ status: res.status, detail: t }));
        return res.blob();
      })
      .then((blob) => {
        try {
          const downloadUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = fileInfo.originalName || fileInfo.name || 'file';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(downloadUrl);
        } catch (err) {
          const blobUrl = URL.createObjectURL(blob);
          window.open(blobUrl, '_blank');
          URL.revokeObjectURL(blobUrl);
        }
      })
      .catch((error_) => {
        // eslint-disable-next-line no-console
        console.error('Get file error', error_);
        alert(this.t('An error occurred while fetching the file.'));
      });
  }
}