import components from './components';
import templates from './templates';

// Opt-in provider — not auto-registered. The default export has no `providers`
// key, so Formio.use() only wires components/templates; the host registers this.
export { createChefsProvider } from './providers';
export type { ChefsProviderConfig } from './providers';

export default {
  components,
  templates,
};
