import { Components, Providers } from '@formio/js';
import editForm from './BCGovFile.form';
import { Constants } from '../Common/Constants';
import {
  createOfflineKey,
  deleteOfflineFile,
  getOfflineFile,
  getOfflineStorageStrategy,
  listOfflineFiles,
  markOfflineFileUploaded,
  OfflineFileMeta,
  OfflineFileRecord,
  OfflineStorageStrategy,
  requestPersistentStorage,
  saveOfflineFile,
  updateOfflineFileMeta,
} from './offlineStorage';
import { claimOfflineFile, isOfflineFileClaimed, ReleaseClaim } from './uploadClaims';

// Tolerate @formio/js being mocked/absent (e.g. SSR).
const baseFile = (Components as any)?.components?.file;
const ParentComponent = baseFile || class {
  public static schema(...extend: any[]) {
    return Object.assign({}, ...extend);
  }
};

type OwnOfflineFileLookup =
  | { status: 'own'; record: OfflineFileRecord }
  | { status: 'unavailable' }
  | { status: 'unknown' };

const ID = 'bcgov-file';
// Retries of files whose upload failed while online back off from 30s, doubling up to 5 minutes
const OFFLINE_RETRY_MS = 30000;
const OFFLINE_RETRY_MAX_MS = 300000;
// Records of uploaded files (see markOfflineFileUploaded) are dropped on submit, or after this long
const UPLOADED_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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

  // Stored files whose DataGrid/EditGrid row was removed and are being deleted; never restored
  private static removedOfflineKeys = new Set<string>();

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

  private offlineInitialSyncDone = false;
  // Path the stored files' componentPath was last brought up to date with
  private storedFilesPath: string | null = null;
  private offlineRefresh: Promise<void> = Promise.resolve();
  // Next retry of stored files that failed to upload while online
  private offlineRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private offlineRetryDelay = OFFLINE_RETRY_MS;
  // Files uploaded during the current sync, by offlineKey (see tidyOfflineValue)
  private uploadedThisSync = new Map<string, any>();
  // Uploaded from browser storage in this page load, so their rows can say so
  private uploadedFromStorage = new WeakSet<object>();
  // Why a stored file's last upload was refused, when the server said; shown on its pending badge
  private offlineUploadErrors = new Map<string, string>();
  // Kept outside the component's element, which is replaced on every redraw
  private liveRegion: HTMLElement | null = null;
  // Handed to Form.io's submit button as this component's "upload in progress" marker
  // Cross-tab upload claims this instance holds (see uploadClaims), released when it is destroyed
  private heldClaims = new Set<ReleaseClaim>();
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
    // An old draft holding this file's placeholder must not be given the deleted file
    this.forgetUploadedRecords((meta) => meta.uploaded?.id === fileInfo?.id).catch(() => undefined);
    return this.fileService.deleteFile(fileInfo, this.component.options ?? {});
  }

  public getFile(fileInfo: any) {
    if (!fileInfo?.offline) {
      return super.getFile(fileInfo);
    }
    return this.lookupOwnOfflineFile(fileInfo).then((lookup) => {
      if (lookup.status !== 'own') {
        return;
      }
      if (lookup.record.meta.uploaded) {
        return super.getFile(lookup.record.meta.uploaded);
      }
      const downloadUrl = URL.createObjectURL(lookup.record.blob);
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
      this.addEventListener(window, 'online', () => {
        this.offlineRetryDelay = OFFLINE_RETRY_MS;
        this.refreshOfflineFiles();
      });
      if (!this.offlineInitialSyncDone) {
        // Pick up files stored in an earlier session (closed window, restored draft)
        this.offlineInitialSyncDone = true;
        this.refreshOfflineFiles();
      } else if (this.offlineComponentPath !== this.storedFilesPath && this.hasStoredFilesOnForm()) {
        // Redrawn under a new path, e.g. a DataGrid row above was removed
        this.refreshOfflineFiles();
      }
    }
    this.markOfflineFiles(element);
    this.updatePendingUploads();
    return result;
  }

  public setValue(value: any, flags: any = {}) {
    const changed = super.setValue(value, flags);
    // A submission/draft set after load would replace restored rows, so merge them back in. Not on a
    // reset, which would be undone (resetValue clears the stored copies instead).
    if (this.offlineInitialSyncDone && !flags?.resetValue) {
      this.refreshOfflineFiles();
    }
    this.updatePendingUploads();
    return changed;
  }

  /**
   * A reset clears the files, so also clear this component's copies stored in the browser; left
   * there they'd come back on the next restore. Captured first: Form.io unsets the value before
   * setting the empty one.
   */
  public resetValue() {
    const pending = (Array.isArray(this.dataValue) ? this.dataValue : []).filter((f: any) => f?.offline);
    super.resetValue();
    // Queued with refreshes so a restore already in flight can't re-add them afterwards
    this.offlineRefresh = this.offlineRefresh
      .then(() => this.clearStoredFiles(pending))
      .catch(() => undefined);
  }

  public destroy(all = false) {
    // Don't leave the submit button disabled on behalf of a component that is gone
    if (this.pendingUploadReported) {
      this.pendingUploadReported = false;
      this.emit('fileUploadingEnd', this.pendingUploadToken);
    }
    this.liveRegion?.remove();
    this.liveRegion = null;
    if (this.offlineRetryTimer) {
      clearTimeout(this.offlineRetryTimer);
      this.offlineRetryTimer = null;
    }
    this.heldClaims.forEach((release) => release());
    this.forgetRemovedStoredFiles();
    return super.destroy(all);
  }

  /**
   * Store locally first when the browser supports it (IndexedDB > localStorage), then upload through
   * Form.io's own uploadFile (progress bar, abort, group permissions, multipart) when online.
   *   - uploaded: the stored copy is deleted
   *   - offline, or a temporary failure: the stored placeholder goes into the value as pending
   *   - rejected by the server, or aborted: the stored copy is deleted and Form.io shows the error
   * Without browser storage, upload directly if online or fail if offline. Retries of stored files
   * come through here too, as rows carrying `offlinePlaceholder` (see retryOfflineFiles).
   * The stored file is claimed for the whole upload, so no other tab uploads it at the same time.
   */
  public async uploadFile(fileToSync: any) {
    try {
      return await this.uploadClaimedFile(fileToSync);
    } finally {
      fileToSync.releaseClaim?.();
      delete fileToSync.releaseClaim;
    }
  }

  private async uploadClaimedFile(fileToSync: any) {
    const online = this.browserIsOnline();
    if (!fileToSync.offlinePlaceholder) {
      const strategy = await getOfflineStorageStrategy();
      if (strategy !== 'none') {
        try {
          // Claimed before it is stored, so another tab can't restore and upload it in between
          const offlineKey = createOfflineKey();
          this.holdClaim(fileToSync, await claimOfflineFile(offlineKey));
          fileToSync.offlinePlaceholder = await this.storeFileLocally(fileToSync, strategy, offlineKey);
        } catch (e) {
          // e.g. file exceeds the localStorage quota; upload directly instead when we can
          if (!online) {
            throw e;
          }
        }
      }
    }
    const placeholder = fileToSync.offlinePlaceholder;

    if (!online) {
      if (!placeholder) {
        throw this.t('You are offline and this browser does not support offline file storage. Please reconnect and try again.');
      }
      this.keepSavedLocallyMessage(
        fileToSync,
        this.t('Saved offline. It will be uploaded when you are back online.'),
      );
      return placeholder;
    }

    let fileInfo: any;
    try {
      fileInfo = await super.uploadFile(fileToSync);
    } catch (err) {
      if (!placeholder) {
        throw err;
      }
      if (this.isPermanentUploadError(err) || err?.type === 'abort') {
        await deleteOfflineFile(placeholder.offlineStorage, placeholder.offlineKey).catch(() => undefined);
        this.offlineUploadErrors.delete(placeholder.offlineKey);
        // A later attempt at this error row starts again from the file
        delete fileToSync.offlinePlaceholder;
        throw err;
      }
      // Anything else may be about the request rather than the file (wrong URL, missing submission,
      // a deploy in progress, auth), so the stored copy is kept and retried, or removed by the user
      const reason = err?.status ? this.describeUploadError(err) : err?.status === 0 ? this.t('network error') : '';
      if (reason) {
        this.offlineUploadErrors.set(placeholder.offlineKey, reason);
      } else {
        this.offlineUploadErrors.delete(placeholder.offlineKey);
      }
      this.keepSavedLocallyMessage(
        fileToSync,
        reason
          ? this.t('Saved locally. Upload failed ({{reason}}); it will be retried.', { reason })
          : this.t('Saved locally. The upload will be retried shortly.'),
      );
      return placeholder;
    }

    if (placeholder) {
      // Kept as a record of the upload until the submission is submitted, so a draft saved with the
      // placeholder still gets this file (see resolveOfflinePlaceholders)
      const marked = await markOfflineFileUploaded(placeholder.offlineStorage, placeholder.offlineKey, fileInfo)
        .catch(() => false);
      if (!marked) {
        await deleteOfflineFile(placeholder.offlineStorage, placeholder.offlineKey).catch(() => undefined);
      }
      this.offlineUploadErrors.delete(placeholder.offlineKey);
      this.offlineRetryDelay = OFFLINE_RETRY_MS;
      this.uploadedThisSync.set(placeholder.offlineKey, fileInfo);
    }
    if (fileToSync.offlineRetry) {
      this.uploadedFromStorage.add(fileInfo);
      this.announce(this.t('{{name}} uploaded', { name: fileToSync.originalName || fileInfo.name }));
      this.emit('bcgovFileUploaded', { fileInfo });
    }
    return fileInfo;
  }

  public async syncFiles() {
    try {
      return await super.syncFiles();
    } finally {
      this.tidyOfflineValue(this.uploadedThisSync);
      this.uploadedThisSync = new Map();
      this.scheduleOfflineRetry();
    }
  }

  /**
   * Give stored files a last chance to upload before the submit validates. Form.io settles these
   * with Promise.allSettled and ignores rejections, so the actual block is validateComponent.
   */
  public init() {
    super.init();
    // The submitted value now references the uploads, so their records are no longer needed
    this.on('submitDone', () => {
      const ids = new Set(
        (Array.isArray(this.dataValue) ? this.dataValue : []).filter((f: any) => f && !f.offline).map((f: any) => f.id),
      );
      this.forgetUploadedRecords((meta) => ids.has(meta.uploaded?.id)).catch(() => undefined);
    });
  }

  public async beforeSubmit() {
    await super.beforeSubmit();
    if (this.browserIsOnline()) {
      await this.refreshOfflineFiles();
    }
  }

  /**
   * Pending files fail submit validation, which Form.io does honour (webforms and wizards alike).
   * Only for submits: drafts aren't validated, and live validation shouldn't flag a file that is
   * simply still uploading.
   */
  public validateComponent(data: any = null, row: any = null, flags: any = {}) {
    const result = super.validateComponent(data, row, flags);
    if (flags?.process !== 'submit' || !this.pendingUploadCount) {
      return result;
    }
    const addPendingError = (errors: any[]) => {
      const [pendingError] = this.interpolateErrors([
        {
          ruleName: 'bcgovPendingUploads',
          level: 'error',
          errorKeyOrMessage: this.t('Some files have not finished uploading. Please try again.'),
          context: {
            component: this.component,
            path: this.path || this.component.key,
            field: this.component.label || this.component.key,
            hasLabel: false,
            level: 'error',
          },
        },
      ]);
      this._errors = [...errors, pendingError];
      return this._errors;
    };
    return flags.async ? result.then(addPendingError) : addPendingError(result);
  }

  /**
   * Restore stored files into the value, then upload them if online. Runs serially. Not in the
   * builder or a read-only/preview view: nothing there can save a changed value, so hiding,
   * restoring or uploading (which deletes the stored copy) would lose the files.
   */
  public refreshOfflineFiles() {
    if (this.builderMode || this.options?.readOnly || this.options?.preview) {
      return this.offlineRefresh;
    }
    this.offlineRefresh = this.offlineRefresh
      .then(() => this.updateStoredFilePaths())
      .then(() => this.restoreOfflineFiles())
      .then(() => this.retryOfflineFiles())
      .catch(() => undefined);
    return this.offlineRefresh;
  }

  public validateFileSettings(file: any) {
    const { blockedExtensions, fileMaxSize } = this.systemFileConfig;

    const ext = this.getFileExtension(file);
    if (ext && blockedExtensions.includes(ext)) {
      return {
        status: 'error',
        message: this.t('Files of type .{{ext}} are not permitted', { ext }),
      };
    }

    // server ceiling, on top of the component's own fileMaxSize
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

  // Which submission stored files belong to: set by the host (e.g. to the submission id) via
  //   Formio.createForm(el, form, { bcgovFile: { offlineScope: submissionId } });
  // otherwise the id of the submission Form.io has loaded. A new submission has neither, so
  // files are still stored and uploaded while the page is open but never restored: the form id
  // isn't enough, as files from one submission would restore (and upload) into another.
  private get offlineScope(): string {
    const scope = this.options?.bcgovFile?.offlineScope;
    const value = typeof scope === 'function' ? scope() : scope;
    return String(value || this.root?.submission?._id || '');
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

  /**
   * The stored file if it is the current user's. 'unavailable' only on a definite answer (not in
   * this browser, or another user's); 'unknown' when storage or the user lookup failed, so callers
   * can leave the file alone rather than treat an error as someone else's file.
   */
  private async lookupOwnOfflineFile(fileInfo: any): Promise<OwnOfflineFileLookup> {
    let record: OfflineFileRecord | null;
    try {
      record = await getOfflineFile(fileInfo.offlineStorage, fileInfo.offlineKey);
    } catch {
      return { status: 'unknown' };
    }
    if (!record) {
      return { status: 'unavailable' };
    }
    if (record.meta?.userId === undefined) {
      return { status: 'own', record };
    }
    let userId: string | undefined;
    try {
      userId = await this.resolveUserId();
    } catch {
      return { status: 'unknown' };
    }
    return this.isOwnedBy(record.meta, userId) ? { status: 'own', record } : { status: 'unavailable' };
  }

  private async deleteOwnOfflineFile(fileInfo: any) {
    const lookup = await this.lookupOwnOfflineFile(fileInfo);
    if (lookup.status !== 'own') {
      return;
    }
    const uploaded = lookup.record.meta.uploaded;
    if (uploaded && !this.uploadedIdsInForm().has(uploaded.id)) {
      await this.fileService.deleteFile(uploaded, this.component.options ?? {});
    }
    await deleteOfflineFile(fileInfo.offlineStorage, fileInfo.offlineKey);
  }

  /** Ids of uploaded files in any BCGovFile on the form. */
  private uploadedIdsInForm(): Set<any> {
    const ids = new Set<any>();
    const collect = (comp: any) =>
      (Array.isArray(comp.dataValue) ? comp.dataValue : [])
        .filter((f: any) => f && !f.offline && f.id != null)
        .forEach((f: any) => ids.add(f.id));
    collect(this);
    const root: any = this.root;
    if (typeof root?.everyComponent === 'function') {
      root.everyComponent((comp: any) => {
        if (comp instanceof BCGovFile) {
          collect(comp);
        }
      });
    }
    return ids;
  }

  /**
   * Delete the current user's records of uploaded files that match, plus any past the TTL. Only
   * metadata is left in these records, so nothing that still needs uploading is lost.
   */
  private async forgetUploadedRecords(matches: (meta: OfflineFileMeta) => boolean) {
    let userId: string | undefined;
    try {
      userId = await this.resolveUserId();
    } catch {
      userId = undefined;
    }
    const expired = Date.now() - UPLOADED_RECORD_TTL_MS;
    for (const { meta, strategy } of await listOfflineFiles()) {
      if (!meta?.uploaded) {
        continue;
      }
      if ((meta.uploadedAt ?? 0) < expired || (this.isOwnedBy(meta, userId) && matches(meta))) {
        await deleteOfflineFile(strategy, meta.offlineKey).catch(() => undefined);
      }
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

  // The server refused the file itself, so retrying won't help and the stored copy is dropped:
  // too large (413), type not allowed (415), failed the virus scan (422). Other 4xx can come from a
  // wrong filesUrl, a gateway mid-deploy or a missing submission, so retried like 5xx and
  // network errors.
  private isPermanentUploadError(response: any): boolean {
    return [413, 415, 422].includes(response?.status);
  }

  // The server's message for a refused upload
  private describeUploadError(err: any): string {
    const text = String(err?.message ?? err ?? '');
    let message = text;
    try {
      const body = JSON.parse(text);
      message = body?.message || body?.detail || body?.error || text;
    } catch {}
    message = String(message).trim() || `HTTP ${err?.status}`;
    return message.length > 120 ? `${message.slice(0, 117)}...` : message;
  }

  /**
   * Form.io's upload() sets 'Succefully uploaded' on every row whose uploadFile resolves, which is
   * wrong for a file only saved locally. Pin this row's message instead; the row is discarded once
   * syncFiles finishes.
   */
  private keepSavedLocallyMessage(fileToSync: any, message: string) {
    Object.defineProperty(fileToSync, 'message', {
      configurable: true,
      enumerable: true,
      get: () => message,
      set: () => undefined,
    });
  }

  // The provider re-checks this against the token it sends, so a stored file is only ever uploaded
  // as the user who added it.
  private expectUser(fileToSync: any, userId: string | undefined) {
    if (userId !== undefined) {
      fileToSync.options = { ...(fileToSync.options ?? this.component.options), expectedUserId: userId };
    }
  }

  // Keep a claim until the row's upload attempt ends (or the component is destroyed).
  private holdClaim(row: any, release: ReleaseClaim | null) {
    if (!release) {
      return;
    }
    const releaseOnce = () => {
      if (this.heldClaims.delete(releaseOnce)) {
        release();
      }
    };
    this.heldClaims.add(releaseOnce);
    row.releaseClaim = releaseOnce;
  }

  private async storeFileLocally(fileToSync: any, strategy: OfflineStorageStrategy, offlineKey: string) {
    const file = fileToSync.file;
    let userId: string | undefined;
    try {
      userId = await this.resolveUserId();
    } catch {
      throw this.t('Unable to confirm who is signed in. Please sign in again and retry.');
    }
    const meta: OfflineFileMeta = {
      offlineKey,
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
      if (e?.code === 'too-large') {
        throw this.t('This file is too large to save while offline. Please reconnect to upload it.');
      }
      throw this.t('Unable to save the file locally: ') + (e?.message || e);
    }
    this.expectUser(fileToSync, userId);
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
    await this.resolveOfflinePlaceholders();
    await this.forgetUploadedRecords(() => false).catch(() => undefined);
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
    } catch {
      // Session can't be confirmed; restore once it can
      return;
    }

    const stored = await listOfflineFiles();
    // Read after the await, so nothing restored meanwhile is missed
    const current = Array.isArray(this.dataValue) ? this.dataValue : [];
    const knownKeys = this.offlineKeysInForm();
    const candidates = stored
      .filter(({ meta }) => !meta.uploaded)
      .filter(({ meta }) => meta.scope === scope && meta.componentPath === this.offlineComponentPath)
      .filter(({ meta }) => this.isOwnedBy(meta, userId))
      .filter(({ meta }) => !knownKeys.has(meta.offlineKey) && !BCGovFile.removedOfflineKeys.has(meta.offlineKey));
    // Files another tab is uploading right now will be gone once it finishes
    const claimed = await Promise.all(candidates.map(({ meta }) => isOfflineFileClaimed(meta.offlineKey)));
    let missing = candidates
      .filter((_, i) => !claimed[i])
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
   * Delete the current user's stored copies for this form (matched by scope and path,
   * plus any given placeholders). Other users' copies are left alone.
   */
  private async clearStoredFiles(placeholders: any[] = []) {
    let userId: string | undefined;
    try {
      userId = await this.resolveUserId();
    } catch {
      return;
    }
    const scope = this.offlineScope;
    const toDelete = new Map<string, OfflineStorageStrategy>();
    placeholders.forEach((p) => toDelete.set(p.offlineKey, p.offlineStorage));
    if (scope) {
      (await listOfflineFiles())
        .filter(({ meta }) => meta.scope === scope && meta.componentPath === this.offlineComponentPath)
        .forEach(({ meta, strategy }) => toDelete.set(meta.offlineKey, strategy));
    }
    for (const [key, strategy] of toDelete) {
      const record = await getOfflineFile(strategy, key).catch(() => null);
      if (record && this.isOwnedBy(record.meta, userId)) {
        await deleteOfflineFile(strategy, key);
      }
    }
  }

  // Placeholders on this field, including ones being retried
  private storedFilesOnForm(): any[] {
    const values = (Array.isArray(this.dataValue) ? this.dataValue : []).filter((f: any) => f?.offline);
    const retrying = (this.filesToSync?.filesToUpload ?? [])
      .map((row: any) => row?.offlinePlaceholder)
      .filter(Boolean);
    return [...values, ...retrying];
  }

  private hasStoredFilesOnForm(): boolean {
    return this.storedFilesOnForm().length > 0;
  }

  /**
   * Keep each stored file's componentPath in step with where it sits, so a reload restores it
   * into the same DataGrid row after rows above it were removed.
   */
  private async updateStoredFilePaths() {
    const path = this.offlineComponentPath;
    this.storedFilesPath = path;
    for (const placeholder of this.storedFilesOnForm()) {
      const lookup = await this.lookupOwnOfflineFile(placeholder);
      if (lookup.status === 'own' && lookup.record.meta.componentPath !== path) {
        await updateOfflineFileMeta(placeholder.offlineStorage, placeholder.offlineKey, { componentPath: path })
          .catch(() => undefined);
      }
    }
  }

  /**
   * A removed DataGrid/EditGrid row takes its pending files with it, so delete the user's stored
   * copies of any that are no longer anywhere in the form's data; otherwise they'd be restored into
   * whichever row later has that path. Redraws, rebuilds and teardown keep the data, so keep them.
   * Checked synchronously on destroy (the grid has already removed the row's data by then) and the
   * keys held back from restore until deleted, as the row moving into this path restores at once.
   */
  private forgetRemovedStoredFiles() {
    const pending = (Array.isArray(this.dataValue) ? this.dataValue : []).filter((f: any) => f?.offline);
    const root: any = this.root;
    if (!pending.length || !root) {
      return;
    }
    const keysInData = new Set<string>();
    const walk = (value: any, seen: Set<any>) => {
      if (!value || typeof value !== 'object' || seen.has(value)) {
        return;
      }
      seen.add(value);
      if (typeof value.offlineKey === 'string') {
        keysInData.add(value.offlineKey);
      }
      Object.values(value).forEach((child) => walk(child, seen));
    };
    walk(root.data, new Set());
    const removed = pending.filter((placeholder: any) => !keysInData.has(placeholder.offlineKey));
    removed.forEach((placeholder: any) => BCGovFile.removedOfflineKeys.add(placeholder.offlineKey));
    removed.forEach(async (placeholder: any) => {
      try {
        if ((await this.lookupOwnOfflineFile(placeholder)).status === 'own') {
          await deleteOfflineFile(placeholder.offlineStorage, placeholder.offlineKey);
        }
      } catch {
        return;
      }
      BCGovFile.removedOfflineKeys.delete(placeholder.offlineKey);
    });
  }

  /**
   * Offline keys of every stored file already on the form, in any BCGovFile, including ones being
   * retried. A file's stored componentPath goes stale when its DataGrid row moves (a row above is
   * removed), so checking only this component would restore it a second time into whichever row
   * now has that path.
   */
  private offlineKeysInForm(): Set<string> {
    const keys = new Set<string>();
    const collect = (comp: BCGovFile) => comp.storedFilesOnForm().forEach((f: any) => keys.add(f.offlineKey));
    collect(this);
    const root: any = this.root;
    if (typeof root?.everyComponent === 'function') {
      root.everyComponent((comp: any) => {
        if (comp instanceof BCGovFile) {
          collect(comp);
        }
      });
    }
    return keys;
  }

  /**
   * Settle placeholders that no longer stand for a pending file:
   *   - already uploaded (by this tab before a draft with the placeholder was loaded, or by another
   *     tab): swapped for the uploaded file, or dropped if the form already lists it
   *   - another user's, or stored in another browser (e.g. a draft saved elsewhere): taken off the
   *     form. Their stored copies are kept, so the owner gets them back by restore in their browser.
   * Files whose lookup failed are kept; the next refresh checks them again.
   */
  private async resolveOfflinePlaceholders() {
    const pending = (Array.isArray(this.dataValue) ? this.dataValue : []).filter((f: any) => f?.offline);
    if (!pending.length) {
      return;
    }
    const replacements = new Map<any, any>();
    for (const fileInfo of pending) {
      const lookup = await this.lookupOwnOfflineFile(fileInfo);
      if (lookup.status === 'unavailable') {
        replacements.set(fileInfo, null);
      } else if (lookup.status === 'own' && lookup.record.meta.uploaded) {
        replacements.set(fileInfo, lookup.record.meta.uploaded);
      }
    }
    const uploaded = new Map<string, any>();
    replacements.forEach((fileInfo, placeholder) => uploaded.set(placeholder.offlineKey, fileInfo));
    this.tidyOfflineValue(uploaded);
  }

  /**
   * The value can be replaced while files upload (a draft or submission set after load), so a sync
   * can leave a placeholder beside its own upload or a second placeholder for the same file. Keep
   * one entry per file: placeholders of uploaded files become the upload (or go, if it's already
   * listed), those mapped to null go, and repeated offlineKeys go.
   */
  private tidyOfflineValue(uploaded: Map<string, any>) {
    const value = Array.isArray(this.dataValue) ? this.dataValue : [];
    const listed = this.uploadedIdsInForm();
    const seenKeys = new Set<string>();
    let changed = false;
    const tidied = value.flatMap((f: any) => {
      if (!f?.offline) {
        return [f];
      }
      const replacement = uploaded.get(f.offlineKey);
      if (seenKeys.has(f.offlineKey) || replacement === null) {
        changed = true;
        return [];
      }
      seenKeys.add(f.offlineKey);
      if (!replacement) {
        return [f];
      }
      changed = true;
      if (listed.has(replacement.id)) {
        return [];
      }
      listed.add(replacement.id);
      this.uploadedFromStorage.add(replacement);
      return [replacement];
    });
    if (!changed) {
      return;
    }
    this.dataValue = tidied;
    this.triggerChange();
    this.redraw();
  }

  private async retryOfflineFiles() {
    if (!this.browserIsOnline() || this.isSyncing) {
      return;
    }
    const pending = (this.dataValue || []).filter((f: any) => f?.offline);
    if (!pending.length) {
      return;
    }
    let userId: string | undefined;
    try {
      userId = await this.resolveUserId();
    } catch {
      return;
    }

    const rows: any[] = [];
    for (const placeholder of pending) {
      // Another tab or window may share this storage and be uploading the same file; skip it then.
      // If that upload succeeds the stored copy is gone and the next refresh hides the placeholder.
      const release = await claimOfflineFile(placeholder.offlineKey);
      if (!release) {
        continue;
      }
      // Read after claiming, so a file another tab just finished uploading isn't uploaded again
      const record = await getOfflineFile(placeholder.offlineStorage, placeholder.offlineKey).catch(() => null);
      // An uploaded record means another tab got there first; the next refresh swaps it in
      if (record?.blob && this.isOwnedBy(record.meta, userId)) {
        const row = this.retryRow(placeholder, record);
        this.holdClaim(row, release);
        rows.push(row);
      } else {
        release();
      }
    }
    // A sync may have started while the files were read; the timer tries again
    if (!rows.length || this.isSyncing) {
      rows.forEach((row) => row.releaseClaim?.());
      return;
    }

    // By offlineKey, not identity: the value may have been replaced (with copies) while files were read
    const retrying = new Set(rows.map((row) => row.offlinePlaceholder.offlineKey));
    this.dataValue = this.dataValue.filter((f: any) => !(f?.offline && retrying.has(f.offlineKey)));
    this.filesToSync.filesToUpload.push(...rows);
    await this.syncFiles();
  }

  // An upload row for a stored file, shaped like Form.io's prepareFileToUpload builds them.
  private retryRow(placeholder: any, record: OfflineFileRecord) {
    const file = new File([record.blob], placeholder.originalName, { type: placeholder.type });
    const { groupKey, groupPermissions } = this.getGroupPermissions();
    const row: any = {
      // Abort buttons are matched by an id split on '-', so none in it
      id: placeholder.offlineKey.replace(/-/g, ''),
      storage: this.component.storage,
      file,
      name: placeholder.name,
      originalName: placeholder.originalName,
      dir: placeholder.dir,
      fileKey: this.component.fileKey || 'file',
      options: this.component.options,
      size: placeholder.size,
      hash: placeholder.hash,
      url: this.interpolate(this.component.url ?? '', { file: placeholder }),
      groupPermissions,
      groupResourceId: groupKey ? this.currentForm?.submission?.data?.[groupKey]?._id : null,
      status: 'info',
      message: this.t('Uploading saved file...'),
      offlinePlaceholder: placeholder,
      offlineRetry: true,
    };
    this.expectUser(row, record.meta.userId);
    return row;
  }

  // While online, files that are still only stored (temporary failure) are retried.
  private scheduleOfflineRetry() {
    const pending = (this.dataValue || []).some((f: any) => f?.offline);
    if (!pending) {
      this.offlineRetryDelay = OFFLINE_RETRY_MS;
    }
    if (this.offlineRetryTimer || !pending || !this.browserIsOnline()) {
      return;
    }
    this.offlineRetryTimer = setTimeout(() => {
      this.offlineRetryTimer = null;
      this.refreshOfflineFiles();
    }, this.offlineRetryDelay);
    this.offlineRetryDelay = Math.min(this.offlineRetryDelay * 2, OFFLINE_RETRY_MAX_MS);
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
      const reason = this.offlineUploadErrors.get(fileInfo.offlineKey);
      badge.textContent = reason
        ? this.t('Saved locally - upload failed ({{reason}}), retrying', { reason })
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
