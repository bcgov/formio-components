/* tslint:disable */
import { Components } from '@formio/js';
import editForm from './BCGovFile.form';
import { Constants } from '../Common/Constants';

// Defensively access components in case @formio/js is mocked/stubbed in SSR.
const baseFile = (Components as any)?.components?.file;
const ParentComponent = baseFile || class {
  static schema(...extend: any[]) {
    return Object.assign({}, ...extend);
  }
};

const ID = 'bcgov-file';
const DISPLAY = 'File Upload';

/**
 * BCGov file upload component.
 *
 * All storage operations (upload / download / delete) go through Form.io's
 * standard `fileService` + storage-provider system. This component contains no
 * transport code, tokens, tenant ids, or fixed URLs: it simply defaults its
 * `storage` to `'chefs'`. A host application registers a matching provider (see
 * `createChefsProvider`) and injects its own runtime config there, so swapping
 * storage is config-only with no change to this component.
 */
export default class BCGovFile extends ParentComponent {
  static schema(...extend) {
    return ParentComponent.schema(
      {
        type: ID,
        label: DISPLAY,
        key: ID,
        // Selects the storage provider the host registers under this name.
        storage: 'chefs',
        // Multipart form-field name for the file (matches the backend contract).
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
      ...extend
    );
  }

  public static readonly editForm = editForm;

  static get builderInfo() {
    return {
      title: DISPLAY,
      group: 'bcgov',
      icon: 'file',
      weight: 0,
      documentation: Constants.DEFAULT_HELP_LINK,
      schema: BCGovFile.schema(),
    };
  }

  /**
   * The base File component gates `deleteFile()` behind a hardcoded allowlist of
   * storage names (url/indexeddb/s3/azure/googledrive) that does not include
   * custom providers. Override it to route deletes through the standard
   * fileService/provider, exactly like the inherited upload/download paths.
   */
  deleteFile(fileInfo: any) {
    return this.fileService.deleteFile(fileInfo, this.component.options ?? {});
  }
}
