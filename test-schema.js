function sanitizeSchema(schema) {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchema);
  } else if (schema !== null && typeof schema === 'object') {
    const newObj = {};
    const allowedKeys = ['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required'];
    for (const key of Object.keys(schema)) {
      if (allowedKeys.includes(key)) {
        if (key === 'properties' && schema.properties && typeof schema.properties === 'object') {
          const props = {};
          for (const propName of Object.keys(schema.properties)) {
            props[propName] = sanitizeSchema(schema.properties[propName]);
          }
          newObj.properties = props;
        } else {
          newObj[key] = sanitizeSchema(schema[key]);
        }
      }
    }
    return newObj;
  }
  return schema;
}

const input = {
  type: 'object',
  properties: {
    location: { type: 'string', description: 'The city', additionalProperties: false },
    unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
  },
  required: ['location'],
  additionalProperties: false
};

console.log(JSON.stringify(sanitizeSchema(input), null, 2));
