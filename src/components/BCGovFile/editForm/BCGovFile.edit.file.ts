import { Formio } from '@formio/js';

// Built-in Form.io storage providers. These require an enterprise license, and
// this component exists specifically as a non-enterprise workaround, so they are
// hidden from the picker — only custom-registered providers (e.g. 'chefs') show.
const STOCK_STORAGE_PROVIDERS = ['base64', 's3', 'url', 'azure', 'indexeddb', 'googledrive'];

export default [
  {
    type: 'select',
    input: true,
    key: 'storage',
    label: 'Storage Provider',
    placeholder: 'Select the file storage provider',
    weight: 0,
    tooltip:
      'Which registered storage provider handles uploads/downloads/deletes. Defaults to the CHEFS provider; a host that registers its own provider can select it here with no change to this component.',
    valueProperty: 'value',
    dataSrc: 'custom',
    data: {
      // Populate from custom-registered storage providers only (built-ins hidden).
      custom() {
        const providers = (Formio as any)?.Providers?.getProviders?.('storage') || {};
        return Object.keys(providers)
          .filter((key) => STOCK_STORAGE_PROVIDERS.indexOf(key) === -1)
          .map((key) => ({
            label: (providers[key] && providers[key].title) || key,
            value: key,
          }));
      },
    },
  },
  {
    type: 'datagrid',
    input: true,
    label: 'File Types',
    key: 'fileTypes',
    tooltip:
      'Specify file types to classify the uploads. This is useful if you allow multiple types of uploads but want to allow the user to specify which type of file each is.',
    weight: 11,
    components: [
      {
        label: 'Label',
        key: 'label',
        input: true,
        type: 'textfield',
      },
      {
        label: 'Value',
        key: 'value',
        input: true,
        type: 'textfield',
      },
    ],
  },
  {
    type: 'textfield',
    input: true,
    key: 'filePattern',
    label: 'Allowed File Types',
    placeholder:
      'Leave empty for default or Customize to restrict: .pdf,.jpg,.png',
    tooltip:
      'Default allows for all safe types (non-executables). Enter specific extensions to restrict further.',
    weight: 50,
  },
];