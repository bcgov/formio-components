export default [
    {
        weight: 0,
        type: 'textfield',
        input: true,
        key: 'api',
        label: 'Url to the API Endpoint',
        tooltip: 'Url to the supported API endpoint',
        defaultValue: '/api/v1/upload',
    },
    {
        weight: 10,
        type: 'checkbox',
        label: 'Multiple Values',
        tooltip: 'Allows multiple values to be entered for this field.',
        key: 'multiple',
        input: true
    },
];