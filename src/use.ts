import { Formio } from '@formio/js';
import BCGovFormioComponents from './index';
if ((Formio as any)?.use) {
  (Formio as any).use(BCGovFormioComponents);
}
export default BCGovFormioComponents;
