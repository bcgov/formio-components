import components from './components';
import templates from './templates';

// Opt-in storage provider. NOT auto-registered: the default export below has no
// `providers` key, so `Formio.use(BcGovFormioComponents)` registers components
// and templates only. A host app registers this explicitly and selects it via a
// component's `storage` setting (e.g. `storage: 'chefs'`).
export { createChefsProvider, ChefsProviderConfig } from './providers';

export default {
  components,
  templates,
};
