import _ from 'lodash';
import Evaluator from './Evaluator';
const EditFormUtils = {
  sortAndFilterComponents(components) {
    return _.filter(_.sortBy(components, 'weight'), (item) => !item.ignore);
  },
  unifyComponents(objValue, srcValue) {
    if (objValue.key && srcValue.key) {
      if (objValue.skipMerge || srcValue.skipMerge) {
        return false;
      }
      if (objValue.key === srcValue.key) {
        // Create complete objects by including missing keys.
        _.each(objValue, (value, prop) => {
          if (objValue.overrideEditForm || !srcValue.hasOwnProperty(prop)) {
            srcValue[prop] = value;
          }
        });
        _.each(srcValue, (value, prop) => {
          if (srcValue.overrideEditForm || !objValue.hasOwnProperty(prop)) {
            objValue[prop] = value;
          }
        });

        if (objValue.components) {
          srcValue.components = EditFormUtils.sortAndFilterComponents(
            _.unionWith(objValue.components, srcValue.components, EditFormUtils.unifyComponents)
          );
        }
        return true;
      }
      else {
        return false;
      }
    }
    return _.isEqual(objValue, srcValue);
  },
  logicVariablesTable(additional) {
    additional = additional || '';
    return {
      type: 'htmlelement',
      tag: 'div',
      /* eslint-disable prefer-template */
      content: '<p>The following variables are available in all scripts.</p>' +
      '<table class="table table-bordered table-condensed table-striped">' +
      additional +
      '<tr><th>token</th><td>The decoded JWT token for the authenticated user.</td></tr>' +
      '<tr><th>user</th><td>The current logged in user</td></tr>' +
      '<tr><th>form</th><td>The complete form JSON object</td></tr>' +
      '<tr><th>submission</th><td>The complete submission object.</td></tr>' +
      '<tr><th>data</th><td>The complete submission data object.</td></tr>' +
      '<tr><th>row</th><td>Contextual "row" data, used within DataGrid, EditGrid, and Container components</td></tr>' +
      '<tr><th>component</th><td>The current component JSON</td></tr>' +
      '<tr><th>instance</th><td>The current component instance.</td></tr>' +
      '<tr><th>value</th><td>The current value of the component.</td></tr>' +
      '<tr><th>moment</th><td>The moment.js library for date manipulation.</td></tr>' +
      '<tr><th>_</th><td>An instance of <a href="https://lodash.com/docs/" target="_blank">Lodash</a>.</td></tr>' +
      '<tr><th>utils</th><td>An instance of the <a href="http://formio.github.io/formio.js/docs/identifiers.html#utils" target="_blank">FormioUtils</a> object.</td></tr>' +
      '<tr><th>util</th><td>An alias for "utils".</td></tr>' +
      '</table><br/>'
      /* eslint-enable prefer-template */
    };
  },
  javaScriptValue(title, property, propertyJSON, weight, exampleHTML, exampleJSON, additionalParams = '', excludeJSONLogic) {
    const components = [
      this.logicVariablesTable(additionalParams),
      {
        type: 'panel',
        title: 'JavaScript',
        collapsible: true,
        collapsed: false,
        style: { 'margin-bottom': '10px' },
        key: `${property}-js`,
        customConditional() {
          return !Evaluator.noeval || Evaluator.protectedEval;
        },
        components: [
          {
            type: 'textarea',
            key: property,
            rows: 5,
            editor: 'ace',
            hideLabel: true,
            as: 'javascript',
            input: true
          },
          {
            type: 'htmlelement',
            tag: 'div',
            content: `<p>Enter custom javascript code.</p>${exampleHTML}`
          }
        ]
      },
      {
        type: 'panel',
        title: 'JSONLogic',
        collapsible: true,
        collapsed: true,
        key: `${property}-json`,
        components: [
          {
            type: 'htmlelement',
            tag: 'div',
            /* eslint-disable prefer-template */
            content: '<p>Execute custom logic using <a href="http://jsonlogic.com/" target="_blank">JSONLogic</a>.</p>' +
              '<p>Full <a href="https://lodash.com/docs" target="_blank">Lodash</a> support is provided using an "_" before each operation, such as <code>{"_sum": {var: "data.a"}}</code></p>' +
               exampleJSON
            /* eslint-enable prefer-template */
          },
          {
            type: 'textarea',
            key: propertyJSON,
            rows: 5,
            editor: 'ace',
            hideLabel: true,
            as: 'json',
            input: true
          }
        ]
      }
    ];

    if (excludeJSONLogic) {
      components.splice(2, 1);
    }

    return {
      type: 'panel',
      title: `${title}`,
      theme: 'default',
      collapsible: true,
      collapsed: true,
      key: `${property}Panel`,
      weight: `${weight}`,
      components
    };
  }
};

/**
 * Checks if IndexedDB is supported and fully usable (handles Private Mode/blocked storage).
 */
async function checkIndexedDBSupport() {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return false;
  }

  try {
    return await new Promise((resolve) => {
      // Attempt to open a temporary test database
      const request = window.indexedDB.open('__idb_test_db__');

      request.onerror = () => {
        resolve(false);
      };

      request.onsuccess = () => {
        const db = request.result;
        db.close();

        // Clean up the test database immediately
        try {
          window.indexedDB.deleteDatabase('__idb_test_db__');
        } catch (e) {
          // Ignore cleanup errors
        }

        resolve(true);
      };
    });
  } catch (e) {
    return false;
  }
}

/**
 * Checks if localStorage is supported and fully usable (handles quota errors or disabled storage).
 */
function checkLocalStorageSupport() {
  if (typeof window === 'undefined' || !('localStorage' in window)) {
    return false;
  }

  try {
    const testKey = '__ls_test_key__';
    window.localStorage.setItem(testKey, testKey);
    window.localStorage.removeItem(testKey);
    return true;
  } catch (e) {
    // Catches QuotaExceededError or security restrictions blocking storage
    return false;
  }
}

/**
 * Evaluates available storage based on your priority:
 * IndexedDB -> localStorage -> 'none'
 */
export async function getBestStorageStrategy() {
  // 1. Check IndexedDB first
  if (await checkIndexedDBSupport()) {
    return 'indexeddb';
  }

  // 2. Fall back to localStorage
  if (checkLocalStorageSupport()) {
    return 'localstorage';
  }

  // 3. Fall back to error/none
  return 'none';
}

export default EditFormUtils;