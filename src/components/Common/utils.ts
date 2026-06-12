import Evaluator from './Evaluator';
const EditFormUtils = {
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

export default EditFormUtils;