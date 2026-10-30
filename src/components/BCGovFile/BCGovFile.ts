import { Components, Providers } from '@formio/js';
import editForm from './BCGovFile.form';
import { Constants } from '../Common/Constants';
import {
  createOfflineKey,
  deleteOfflineFile,
  getOfflineFile,
  getOfflineStorageStrategy,
  listOfflineFiles,
  OfflineFileMeta,
  OfflineFileRecord,
  OfflineStorageStrategy,
  requestPersistentStorage,
  saveOfflineFile,
} from './offlineStorage';

// Tolerate @formio/js being mocked/absent (e.g. SSR).
const baseFile = (Components as any)?.components?.file;
const ParentComponent = baseFile || class {
  public static schema(...extend: any[]) {
    return Object.assign({}, ...extend);
  }
};

const ID = 'bcgov-file';
const DISPLAY = 'File Upload';

/**
 * BCGov file upload. Routes upload/download/delete through Form.io's fileService
 * and defaults `storage` to 'chefs'; the host registers the matching provider
 * (createChefsProvider). No transport or config lives here.
 *
 * Files are stored in the browser first (IndexedDB > localStorage) and uploaded
 * from there, straight away when online or once the browser reconnects. Without
 * browser storage they upload directly when online, and fail when offline.
 * Stored files remember who added them and are only uploaded, restored or
 * downloaded while that same user (or, for anonymous files, nobody) is signed in.
 *
 * While files are pending, Form.io's submit button is disabled (through its
 * fileUploadingStart/End events) and the form emits `bcgovFilePendingUploads`
 * with `{ pending }`, the form-wide count, so a host's own save button can follow:
 *   form.on('bcgovFilePendingUploads', ({ pending }) => setSaveDisabled(pending > 0));
 *
 * A stored file that finishes uploading in the background is marked "Uploaded" on
 * its row, announced to screen readers, and emitted as `bcgovFileUploaded` with
 * `{ fileInfo }` so the host can show its own notification.
 */
export default class BCGovFile extends ParentComponent {
  public static readonly editForm = editForm;

  public static schema(...extend: any[]) {
    return ParentComponent.schema(
      {
        type: ID,
        label: DISPLAY,
        key: ID,
        // storage provider name the host registers
        storage: 'chefs',
        // multipart field name for the file
        fileKey: 'file',
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
      ...extend,
    );
  }

  public static get builderInfo() {
    return {
      title: DISPLAY,
      group: 'bcgov',
      icon: 'file',
      weight: 0,
      documentation: Constants.DEFAULT_HELP_LINK,
      schema: BCGovFile.schema(),
    };
  }

  private offlineSyncing = false;
  private offlineInitialSyncDone = false;
  private offlineRefresh: Promise<void> = Promise.resolve();
  private uploadingOfflineKeys = new Set<string>();
  // Uploaded from browser storage in this page load, so their rows can say so
  private uploadedFromStorage = new WeakSet<object>();
  // Kept outside the component's element, which is replaced on every redraw
  private liveRegion: HTMLElement | null = null;
  // Handed to Form.io's submit button as this component's "upload in progress" marker
  private readonly pendingUploadToken = {};
  private pendingUploadReported = false;
  private lastPendingCount = 0;

  /** Files not uploaded yet: stored in the browser, or still being sent. */
  public get pendingUploadCount(): number {
    const offline = (Array.isArray(this.dataValue) ? this.dataValue : []).filter((f: any) => f?.offline).length;
    // Successful rows stay here until syncFiles moves them into the value
    const sending = (this.filesToSync?.filesToUpload ?? []).filter((f: any) => f.status !== 'error').length;
    return offline + sending;
  }

  // Base File only calls fileService.deleteFile for built-in storages
  // (url/s3/azure/...), not custom ones — so route 'chefs' deletes through it.
  // Files not uploaded yet only exist in browser storage.
  public deleteFile(fileInfo: any) {
    if (fileInfo?.offline) {
      return this.deleteOwnOfflineFile(fileInfo);
    }
    return this.fileService.deleteFile(fileInfo, this.component.options ?? {});
  }

  public getFile(fileInfo: any) {
    if (!fileInfo?.offline) {
      return super.getFile(fileInfo);
    }
    return this.getOwnOfflineFile(fileInfo).then((record) => {
      if (!record) {
        return;
      }
      const downloadUrl = URL.createObjectURL(record.blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = fileInfo.originalName || fileInfo.name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(downloadUrl);
    });
  }

  public attach(element: any) {
    const result = super.attach(element);
    if (typeof window !== 'undefined') {
      this.addEventListener(window, 'online', () => this.refreshOfflineFiles());
      if (!this.offlineInitialSyncDone) {
        // Pick up files stored in an earlier session (closed window, restored draft)
        this.offlineInitialSyncDone = true;
        this.refreshOfflineFiles();
      }
    }
    this.markOfflineFiles(element);
    this.updatePendingUploads();
    return result;
  }

  public setValue(value: any, flags = {}) {
    const changed = super.setValue(value, flags);
    // A submission/draft set after load would replace restored rows, so merge them back in
    if (this.offlineInitialSyncDone) {
      this.refreshOfflineFiles();
    }
    this.updatePendingUploads();
    return changed;
  }

  public destroy(all = false) {
    // Don't leave the submit button disabled on behalf of a component that is gone
    if (this.pendingUploadReported) {
      this.pendingUploadReported = false;
      this.emit('fileUploadingEnd', this.pendingUploadToken);
    }
    this.liveRegion?.remove();
    this.liveRegion = null;
    return super.destroy(all);
  }

  /**
   * Store locally first when the browser supports it (IndexedDB > localStorage); syncFiles then
   * uploads from storage. Without browser storage, upload directly if online or fail if offline.
   */
  public async upload() {
    if (!this.filesToSync?.filesToUpload?.length) {
      return Promise.resolve();
    }
    const online = this.browserIsOnline();
    const strategy = await getOfflineStorageStrategy();
    return await Promise.all(
      this.filesToSync.filesToUpload.map(async (fileToSync: any) => {
        let fileInfo: any = null;
        try {
          if (fileToSync.isValidationError) {
            return { fileToSync, fileInfo };
          }

          if (strategy !== 'none') {
            try {
              fileInfo = await this.storeFileLocally(fileToSync, strategy);
            } catch (e) {
              // e.g. file exceeds the localStorage quota; upload directly instead when we can
              if (!online) {
                throw e;
              }
            }
          }

          if (fileInfo) {
            fileToSync.status = 'success';
            fileToSync.message = online
              ? this.t('Saved locally, uploading...')
              : this.t('Saved offline. It will be uploaded when you are back online.');
          } else if (online) {
            fileInfo = await this.uploadFile(fileToSync);
            fileToSync.status = 'success';
            fileToSync.message = this.t('Succefully uploaded');
          } else {
            throw this.t('You are offline and this browser does not support offline file storage. Please reconnect and try again.');
          }
          fileInfo.originalName = fileToSync.originalName;
          fileInfo.hash = fileToSync.hash;
        } catch (response) {
          fileToSync.status = 'error';
          delete fileToSync.progress;
          fileToSync.message = this.getUploadErrorMessage(response);
          this.emit('fileUploadError', { fileToSync, response });
        } finally {
          delete fileToSync.progress;
          this.redraw();
        }
        return { fileToSync, fileInfo };
      }),
    );
  }

  public async syncFiles() {
    try {
      return await super.syncFiles();
    } finally {
      // Files stored locally by upload() are uploaded from storage straight away when online
      this.refreshOfflineFiles();
    }
  }

  /**
   * Backstop for the disabled submit button: final submits wait for stored files to upload, and
   * are blocked if any are still pending. Form.io doesn't run this for drafts.
   */
  public async beforeSubmit() {
    await super.beforeSubmit();
    if (this.browserIsOnline()) {
      await this.refreshOfflineFiles();
    }
    if (this.pendingUploadCount) {
      return Promise.reject(this.t('Some files have not finished uploading. Please try again.'));
    }
  }

  /**
   * Restore stored files into the value, then upload them if online. Runs serially.
   */
  public refreshOfflineFiles() {
    this.offlineRefresh = this.offlineRefresh
      .then(() => this.restoreOfflineFiles())
      .then(() => this.syncOfflineFiles())
      .catch(() => {});
    return this.offlineRefresh;
  }

  // Checked before the base rules, so the host blocklist / size ceiling always
  // win over whatever the form designer set in filePattern/fileTypes.
  public validateFileSettings(file: any) {
    const { blockedExtensions, fileMaxSize } = this.systemFileConfig;

    const ext = this.getFileExtension(file);
    if (ext && blockedExtensions.includes(ext)) {
      return {
        status: 'error',
        message: this.t('Files of type .{{ext}} are not permitted', { ext }),
      };
    }

    // host ceiling, on top of the component's own fileMaxSize
    if (fileMaxSize && !this.validateMaxSize(file, fileMaxSize)) {
      return {
        status: 'error',
        message: this.t('File is too big; it must be at most {{ size }}', { size: fileMaxSize }),
      };
    }

    return super.validateFileSettings(file);
  }

  // Host constraints from the renderer options (not the schema, so a designer
  // can't relax them):
  //   Formio.createForm(el, form, {
  //     bcgovFile: { blockedExtensions: ['exe', 'bat', ...], fileMaxSize: '25MB' },
  //   });
  private get systemFileConfig(): { blockedExtensions: string[]; fileMaxSize: string } {
    const cfg = this.options?.bcgovFile ?? {};
    const blockedExtensions = (Array.isArray(cfg.blockedExtensions) ? cfg.blockedExtensions : [])
      .map((ext: string) => String(ext).trim().toLowerCase().replace(/^\.+/, ''))
      .filter(Boolean);
    return { blockedExtensions, fileMaxSize: cfg.fileMaxSize || '' };
  }

  private getFileExtension(file: any): string {
    const name = file?.name ?? '';
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  private browserIsOnline() {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  // Which form/session stored files belong to. The host can set it (e.g. to the submission id) via
  //   Formio.createForm(el, form, { bcgovFile: { offlineScope: submissionId } });
  // otherwise the form's own id is used. Without either, stored files aren't restored on reload.
  private get offlineScope(): string {
    const scope = this.options?.bcgovFile?.offlineScope;
    const value = typeof scope === 'function' ? scope() : scope;
    return String(value || this.root?.form?._id || this.root?.form?.id || '');
  }

  /**
   * Who is signed in ('' when anonymous), so stored files are only uploaded as the user who added
   * them. The host can set it via `bcgovFile: { getUserId }` (value or getter); otherwise the
   * storage provider is asked (createChefsProvider reads it from the token). undefined when neither
   * can tell; such files aren't tied to a user. Rejects when the session can't be confirmed.
   */
  private async resolveUserId(): Promise<string | undefined> {
    const hostUserId = this.options?.bcgovFile?.getUserId;
    if (hostUserId !== undefined) {
      const value = typeof hostUserId === 'function' ? await hostUserId() : hostUserId;
      return String(value ?? '');
    }
    const Provider: any = (Providers as any)?.getProvider?.('storage', this.component.storage);
    const provider = Provider ? new Provider(this.fileService) : null;
    if (typeof provider?.getUserId !== 'function') {
      return undefined;
    }
    return String((await provider.getUserId()) ?? '');
  }

  private isOwnedBy(meta: OfflineFileMeta | undefined, userId: string | undefined): boolean {
    return meta?.userId === undefined || meta.userId === userId;
  }

  // The stored file, or null when it isn't in this browser or belongs to someone else.
  private async getOwnOfflineFile(fileInfo: any): Promise<OfflineFileRecord | null> {
    const record = await getOfflineFile(fileInfo.offlineStorage, fileInfo.offlineKey).catch(() => null);
    if (!record) {
      return null;
    }
    const userId = await this.resolveUserId().catch(() => null);
    return userId !== null && this.isOwnedBy(record.meta, userId) ? record : null;
  }

  private async deleteOwnOfflineFile(fileInfo: any) {
    if (await this.getOwnOfflineFile(fileInfo)) {
      await deleteOfflineFile(fileInfo.offlineStorage, fileInfo.offlineKey);
    }
  }

  /**
   * Keep Form.io's submit button disabled while files are pending, and tell the host the
   * form-wide count so it can do the same for its own buttons.
   */
  private updatePendingUploads() {
    const count = this.pendingUploadCount;
    if (count && !this.pendingUploadReported) {
      this.pendingUploadReported = true;
      this.emit('fileUploadingStart', this.pendingUploadToken);
    } else if (!count && this.pendingUploadReported) {
      this.pendingUploadReported = false;
      this.emit('fileUploadingEnd', this.pendingUploadToken);
    }
    if (count !== this.lastPendingCount) {
      this.lastPendingCount = count;
      let pending = 0;
      const root: any = this.root;
      if (typeof root?.everyComponent === 'function') {
        root.everyComponent((c: any) => {
          pending += c instanceof BCGovFile ? c.pendingUploadCount : 0;
        });
      } else {
        pending = count;
      }
      this.emit('bcgovFilePendingUploads', { pending });
    }
  }

  // Data path rather than key so files in e.g. different datagrid rows don't collide.
  private get offlineComponentPath(): string {
    return this.path || this.key || this.component.key;
  }

  private getUploadErrorMessage(response: any): string {
    if (typeof response === 'string') {
      return response;
    }
    return response?.type === 'abort' ? this.t('Request was aborted') : String(response);
  }

  // The server rejected the file itself (bad request, too large...), so retrying won't help. Auth,
  // timeout, rate limit, 5xx and network errors are transient and retried later.
  private isPermanentUploadError(response: any): boolean {
    const status = response?.status;
    return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
  }

  private async storeFileLocally(fileToSync: any, strategy: OfflineStorageStrategy) {
    const file = fileToSync.file;
    let userId: string | undefined;
    try {
      userId = await this.resolveUserId();
    } catch (e) {
      throw this.t('Unable to confirm who is signed in. Please sign in again and retry.');
    }
    const meta: OfflineFileMeta = {
      offlineKey: createOfflineKey(),
      scope: this.offlineScope,
      componentPath: this.offlineComponentPath,
      userId,
      name: fileToSync.name,
      originalName: fileToSync.originalName || file.name,
      dir: fileToSync.dir,
      size: file.size,
      type: file.type,
      hash: fileToSync.hash,
      createdAt: Date.now(),
    };
    requestPersistentStorage();
    let usedStrategy: OfflineStorageStrategy;
    try {
      usedStrategy = await saveOfflineFile(strategy, file, meta);
    } catch (e) {
      throw this.t('Unable to save the file locally: ') + (e?.message || e);
    }
    return this.offlinePlaceholder(meta, usedStrategy);
  }

  private offlinePlaceholder(meta: OfflineFileMeta, strategy: OfflineStorageStrategy) {
    return {
      storage: this.component.storage,
      name: meta.name,
      dir: meta.dir,
      url: '',
      size: meta.size,
      type: meta.type,
      originalName: meta.originalName,
      hash: meta.hash,
      offline: true,
      offlineStorage: strategy,
      offlineKey: meta.offlineKey,
    };
  }

  /**
   * Re-attach stored files for this form/component that are missing from the current value, e.g.
   * because the window was closed before the submission data was saved anywhere.
   */
  private async restoreOfflineFiles() {
    if (this.builderMode) {
      return;
    }
    await this.hideUnavailableOfflineFiles();
    if (this.options?.readOnly || this.options?.preview) {
      return;
    }
    const scope = this.offlineScope;
    if (!scope) {
      return;
    }
    const strategy = await getOfflineStorageStrategy();
    if (strategy === 'none') {
      return;
    }
    let userId: string | undefined;
    try {
      userId = await this.resolveUserId();
    } catch (e) {
      // Session can't be confirmed; restore once it can
      return;
    }

    const current = Array.isArray(this.dataValue) ? this.dataValue : [];
    const knownKeys = new Set(current.map((f: any) => f?.offlineKey).filter(Boolean));
    let missing = (await listOfflineFiles())
      .filter(({ meta }) => meta.scope === scope && meta.componentPath === this.offlineComponentPath)
      .filter(({ meta }) => this.isOwnedBy(meta, userId))
      .filter(({ meta }) => !knownKeys.has(meta.offlineKey))
      .sort((a, b) => a.meta.createdAt - b.meta.createdAt);
    if (!missing.length) {
      return;
    }

    if (!this.component.multiple) {
      if (current.length) {
        return;
      }
      missing = missing.slice(-1);
    }

    if (!this.hasValue()) {
      this.dataValue = [];
    }
    this.dataValue.push(...missing.map(({ meta, strategy: stored }) => this.offlinePlaceholder(meta, stored)));
    this.triggerChange();
    this.redraw();
  }

  /**
   * Take pending files the current user can't use off the form: another user's, or ones stored in
   * another browser (e.g. listed in a draft saved elsewhere). Their stored copies are kept, so the
   * owner gets them back by restore in their own browser.
   */
  private async hideUnavailableOfflineFiles() {
    const pending = (Array.isArray(this.dataValue) ? this.dataValue : []).filter((f: any) => f?.offline);
    if (!pending.length) {
      return;
    }
    const unavailable = new Set<any>();
    for (const fileInfo of pending) {
      if (!(await this.getOwnOfflineFile(fileInfo))) {
        unavailable.add(fileInfo);
      }
    }
    if (!unavailable.size) {
      return;
    }
    this.dataValue = this.dataValue.filter((f: any) => !unavailable.has(f));
    this.triggerChange();
    this.redraw();
  }

  /**
   * Upload stored files through the storage provider, replacing their placeholders with the
   * provider's fileInfo.
   */
  private async syncOfflineFiles() {
    if (this.offlineSyncing || !this.browserIsOnline()) {
      return;
    }
    const pending = (this.dataValue || []).filter((f: any) => f?.offline);
    if (!pending.length) {
      return;
    }
    let userId: string | undefined;
    try {
      userId = await this.resolveUserId();
    } catch (e) {
      // Session can't be confirmed (e.g. expired); never fall back to uploading anonymously
      // tslint:disable-next-line:no-console
      console.error('Offline file sync skipped: unable to confirm the signed-in user', e);
      return;
    }

    this.offlineSyncing = true;
    let changed = false;
    try {
      for (const offlineInfo of pending) {
        try {
          const record = await getOfflineFile(offlineInfo.offlineStorage, offlineInfo.offlineKey);
          if (!record) {
            // Stored in another browser/device, nothing we can upload from here
            continue;
          }
          if (!this.isOwnedBy(record.meta, userId)) {
            continue;
          }
          this.uploadingOfflineKeys.add(offlineInfo.offlineKey);
          this.redraw();
          const file = new File([record.blob], offlineInfo.originalName, { type: offlineInfo.type });
          // The provider re-checks the user against the token it sends with the upload
          const options = record.meta.userId === undefined
            ? this.component.options
            : { ...this.component.options, expectedUserId: record.meta.userId };
          // Placeholder rows have no progress bar, so no progress/abort callbacks
          const fileInfo = await this.fileService.uploadFile(
            this.component.storage,
            file,
            offlineInfo.name,
            offlineInfo.dir,
            undefined,
            this.interpolate(this.component.url ?? '', { file: offlineInfo }),
            options,
            this.component.fileKey,
          );
          fileInfo.originalName = offlineInfo.originalName;
          fileInfo.hash = offlineInfo.hash;

          const index = this.dataValue.indexOf(offlineInfo);
          if (index !== -1) {
            this.dataValue[index] = fileInfo;
            changed = true;
            this.uploadedFromStorage.add(fileInfo);
            this.announce(this.t('{{name}} uploaded', { name: fileInfo.originalName || fileInfo.name }));
            this.emit('bcgovFileUploaded', { fileInfo });
          }
          await deleteOfflineFile(offlineInfo.offlineStorage, offlineInfo.offlineKey);
        } catch (err) {
          if (this.isPermanentUploadError(err)) {
            // Drop the stored file and show the rejection as an upload error row
            const index = this.dataValue.indexOf(offlineInfo);
            if (index !== -1) {
              this.dataValue.splice(index, 1);
              changed = true;
            }
            await deleteOfflineFile(offlineInfo.offlineStorage, offlineInfo.offlineKey);
            const fileToSync = {
              id: offlineInfo.offlineKey,
              name: offlineInfo.name,
              originalName: offlineInfo.originalName,
              size: offlineInfo.size,
              status: 'error',
              message: this.getUploadErrorMessage(err),
              // keeps the base component from re-uploading a row that has no file attached
              isValidationError: true,
            };
            this.filesToSync.filesToUpload.push(fileToSync);
            this.emit('fileUploadError', { fileToSync, response: err });
          } else {
            // tslint:disable-next-line:no-console
            console.error('Offline file sync error', err);
          }
        } finally {
          this.uploadingOfflineKeys.delete(offlineInfo.offlineKey);
        }
      }
    } finally {
      this.offlineSyncing = false;
      if (changed) {
        this.triggerChange();
      }
      this.redraw();
    }
  }

  // Label rows whose contents only exist in browser storage.
  private markOfflineFiles(element: any) {
    const files = this.dataValue || [];
    const marked = (f: any) => f?.offline || (f && this.uploadedFromStorage.has(f));
    if (!element || !files.some(marked)) {
      return;
    }
    const rows = element.querySelectorAll('ul.list-group > li.list-group-item:not(.list-group-header)');
    files.forEach((fileInfo: any, index: number) => {
      const cell = rows[index]?.querySelector('.row > div');
      if (!marked(fileInfo) || !cell || cell.querySelector('.bcgov-file-offline')) {
        return;
      }
      const badge = document.createElement('span');
      if (!fileInfo.offline) {
        badge.className = 'bcgov-file-offline badge bg-success ms-2';
        badge.textContent = this.t('Uploaded');
        cell.appendChild(badge);
        return;
      }
      badge.className = 'bcgov-file-offline badge bg-warning text-dark ms-2';
      badge.textContent = this.uploadingOfflineKeys.has(fileInfo.offlineKey)
        ? this.t('Uploading...')
        : this.t('Saved locally - pending upload');
      cell.appendChild(badge);
    });
  }

  // Polite screen reader announcement; the badge alone is re-created silently on each redraw
  private announce(message: string) {
    if (typeof document === 'undefined') {
      return;
    }
    if (!this.liveRegion) {
      this.liveRegion = document.createElement('div');
      this.liveRegion.className = 'visually-hidden';
      this.liveRegion.setAttribute('role', 'status');
      this.liveRegion.setAttribute('aria-live', 'polite');
      document.body.appendChild(this.liveRegion);
    }
    this.liveRegion.textContent = message;
  }
}
