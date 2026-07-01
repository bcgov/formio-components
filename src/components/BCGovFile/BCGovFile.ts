import { Components } from '@formio/js';
import editForm from './BCGovFile.form';
import { Constants } from '../Common/Constants';

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

  // Base File only calls fileService.deleteFile for built-in storages
  // (url/s3/azure/...), not custom ones — so route 'chefs' deletes through it.
  public deleteFile(fileInfo: any) {
    return this.fileService.deleteFile(fileInfo, this.component.options ?? {});
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
}
