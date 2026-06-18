import { Components } from '@formio/js';
const nestedComponentForm = (Components.components.nested as any).editForm;

import EditData from './editForm/BCGovFile.edit.data';
import EditDisplay from './editForm/BCGovFile.edit.display';
import EditFile from './editForm/BCGovFile.edit.file';

import SimpleApi from '../Common/Simple.edit.api';
import SimpleConditional from '../Common/Simple.edit.conditional';
import SimpleValidation from '../Common/Simple.edit.validation';


export default function(...extend) {
    return nestedComponentForm([
        {
            key: 'display',
            components: EditDisplay
        },
        {
            key: 'data',
            ignore: true,
        },
        {
            key: 'api',
            ignore: true
        },
        {
            key: 'layout',
            ignore: true
        },
        {
            key: 'conditional',
            ignore: true
        },
        {
            key: 'validation',
            ignore: true
        },
        {
            key: 'logic',
            ignore: true
        },
        {
            label: 'File',
            key: 'file',
            weight: 10,
            components: EditFile
        },
        {
            label: 'Data',
            key: 'customData',
            weight: 15,
            components: EditData
        },
        {
            label: 'Validation',
            key: 'customValidation',
            weight: 20,
            components: SimpleValidation
        },
        {
            label: 'API',
            key: 'customAPI',
            weight: 30,
            components: SimpleApi
        },
        {
            label: 'Conditional',
            key: 'customConditional',
            weight: 40,
            components: SimpleConditional
        }
    ], ...extend);
}