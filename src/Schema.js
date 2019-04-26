const lodash = require('lodash');
const Ajv = require('ajv');

const ObjectUtils = require('./ObjectUtils');

const ajv = new Ajv({ allErrors: true });

/**
 * valueTypes are schema types which have a value associated with them.
 * Other types (Schema.type === null, for instance) do not have a value
 */
const valueTypes = [
  'string',
  'boolean',
  'object',
  'integer',
  'number',
  'array',
];

/**
 * @class {SchemaPath}
 *
 * Helper class for working with paths
 */
class SchemaPath {
  /**
   * Resolves all segments of a path.
   * 
   * Paths that look like test['abc'].temp are resolved to `test.abc.temp`
   * 
   * @param {string} path a schema path to resolve -- paths into arrays are not supported
   * @return {string} resolved path
   */
  static resolvePath(path) {
    return path.split('.').map((segment) => {
      return segment.replace(/\['/g, '.').replace(/'\]/g, '.').replace(/\.$/, '');
    }).join('.');
  }

  /**
   * Computes the parent of the specified path
   * 
   * `test.abc.temp` => `test.abc`
   * 
   * @param {string} path
   * @return {string} parent path
   */  
  static parentPath(path) {
    return SchemaPath.resolvePath(path)
      .split('.')
      .slice(0, -1)
      .join('.');
  }

  /**
   * Hydrates the specified path from a model path to schema path
   * 
   * `test.abc.temp` => `test.properties.abc.properties.temp`
   * 
   * @param {string} path
   * @return {string} hydrated path
   */  
  static hydratePath(path) {
    return SchemaPath.resolvePath(path)
      .split('.')
      .map((segment) => {
        return `properties.${segment}`;
      })
      .join('.')
      .replace(/\[\d{1,}\]/g, '.items')
      .split('.')
      .map((segment) => {
        return `['${segment}']`;
      })
      .join('.');
  }

  /**
   * Normalizes a schema path into dot notation
   * 
   * `#/test/abc/temp` => `test.abc.temp`
   * 
   * @param {string} path
   * @return {string} hydrated path
   */    
  static normalizeSchemaReferencePath(ref) {
    return ref.replace('#/', '').replace(/\//g, '.');
  }
}


/**
 * @class {SchemaWalkerCallback}
 *
 * Helper class for walking schemas
 */
class SchemaWalkerCallback {
  constructor(callback) {
    this.callback = callback;
    this.cb = this.cb.bind(this);
  }

  cb(propPath, value, parent, key) {
    const required = !!(parent && parent.required && parent.required.includes(key)),
      traverseInto = this.callback(propPath, value, required, parent, key);
    if (traverseInto !== false && value.properties) {
      // undefined, null or a truthy value continues traversal
      return value.properties;
    }
    return undefined;
  }
}

/**
 * @class {SchemaValidationError}
 *
 * Helper class for validation exceptions
 */
class SchemaValidationError extends Error {
  constructor(errors) {
    super(errors.length === 1 ? errors[0].message : 'Schema Validation Error');
    this.errors = errors;
  }

  /**
   * Overload for determining if an exception is a SchemaValidationError
   * 
   * @param {*} type type to statically evaluate
   */
  isPrototypeOf(type) {
    if (type === SchemaValidationError) {
      return true;
    }
    return super.isPrototypeOf(type);
  }

  toString() {
    return `Schema Validation Error Occurred ${JSON.stringify(this.errors)}`;
  }
}

/**
 * @class {Schema}
 * Utility class wrapper for JSON schemas
 * https://tools.ietf.org/html/draft-zyp-json-schema-07
 */
class Schema {
  /*
   * This class *could* wrap the functionality found at
   *   https://github.com/cloudflare/json-schema-tools/tree/master/workspaces
   * Most importantly, https://github.com/cloudflare/json-schema-tools/tree/master/workspaces/json-schema-walker
   * or https://github.com/epoberezkin/json-schema-traverse 
   *   
   */
  constructor(schema = {}) {
    this.schema = schema;
    // TODO: resolve external references
    this.hydrateReferences();
  }

  get properties() {
    return this.schema && this.schema.properties;
  }

  get required() {
    return this.schema && this.schema.required;
  }

  /**
   * Specialized schema walker to callback for $pathRef for text replacement
   * 
   * $pathRef entries are replaced with a context value from the model at
   * the specified path but their value could be any value that is returned
   * from the callback.
   * 
   * For Example:
   * 
   * "properties": {
   *   "date": {
   *    "type": "string"
   *    "examples": [
   *      {"$pathRef": "directives.today"}
   *    ]
   *   }
   * }
   * 
   * would become:
   * 
   * "properties": {
   *   "date": {
   *    "type": "string"
   *    "examples": [
   *      "November 1, 1969"
   *    ]
   *   }
   * }
   * 
   * @param {Object} subSchema The subschema to traverse
   * @param {@param {function(name:string):string}} cb callback to be called for every occurrence of $pathRef
   */
  static fixupPathReferences(subSchema, cb) {
    let result;

    if (Array.isArray(subSchema)) {
      result = [];
      subSchema.forEach((item) => {
        result.push(Schema.fixupPathReferences(item, cb));
      });
    } else if (lodash.isPlainObject(subSchema)) {
      result = {
        ...subSchema,
      };
      Object.keys(result).forEach((key) => {
        const pathRef = subSchema[key].$pathRef;
        if (pathRef) {
          result[key] = cb(pathRef);
        } else {
          result[key] = Schema.fixupPathReferences(subSchema[key], cb);
        }
      });
    } else {
      result = subSchema;
    }

    return result;
  }

  /**
   * Schema Walker
   * 
   * @param {*} subSchema 
   * @param {*} parent 
   * @param {*} keyPath 
   * @param {*} callback {function(name:string, property:object, required:boolean):boolean} callback Invoked for each property in the schema
   */
  static walkSubschemaRecursive(subSchema, parent, keyPath, cb) {
    ObjectUtils.walkObjectRecursive(subSchema, parent, keyPath, new SchemaWalkerCallback(cb).cb);
  }

  /**
   * Walks the properties of the given schema
   *
   * in the component's persisted data - invoking the provided callback for each property. The
   * callback will be invoked with the name of the property and its definition in the schema, as
   * well as a flag indicating if the property is required. Typically, the schema definition will
   * include at least a 'type' but may include '$bloom', 'properties', etc., depending on the type.
   *
   * Note that the return value from the callback is used to determine whether to descend into
   * any of the properties child properties, if any. Return true to continue descending into those
   * child properties or false to avoid doing so. In either case, iteration will continue over the
   * properties at the same level in the schema. There is no provision for stopping iteration
   * prematurely.
   *
   * @param {function(name:string, property:object, required:boolean):boolean} cb Invoked for each property in the schema
   */
  walkProperties(cb) {
    this.walkSubschemaRecursive(this.properties, null, '', cb);
  }

  /**
   * Retrieves the schema for the specified path using dot notation
   * 
   * @param {string} path to retrieve
   * @return {?Object} subschema at the specified path
   */
  getSubschemaFromPath(path) {
    // get the subschema at sections.header.title
    // transform into properties.sections.properties.header.properties.title
    // resolve directives['en-US'] => directives.en-US
    const hydratedPath = SchemaPath.hydratePath(path);
    return lodash.get(this.schema, hydratedPath);
  }

  /**
   * Creates an empty value for the specified node;
   * 
   * For objects, all required properties are created with either
   * their default values or a value from one of the examples specified within 'node`
   * 
   * For all other types, a simple result of the specified type at node is returned
   * 
   * @param {Object} node the Subschema to create
   * @param {Object} [options = {removeEmptyNodes: true}] options
   * @return {*} value
   */
  createDataFromSchema(node, options = {
    removeEmptyNodes: true
  }) {

    const computeExample = (nodeAt, path, parent, key, exampleCache) => {
      let example = nodeAt.examples && nodeAt.examples[0];

      if (!example) {
        const parentExamples = parent && parent.examples;
        example = parentExamples && parentExamples[0][key];
      }

      if (!example && exampleCache) {
        example = lodash.get(Array.isArray(exampleCache) ? lodash.head(exampleCache) : exampleCache, path);
      }

      return example;
    };

    const createWithDefault = (nodeAt, isRequired, _default, path, parent, key, exampleCache) => {
      const example = computeExample(nodeAt, path, parent, key, exampleCache);
      const defaultVal = nodeAt.default;

      if (isRequired) {
        return example || defaultVal || _default;
      }
      return example || undefined;
    };

    const constructValueFromNode = (nodeAt, isRequired, explicitType, path, parent, key, exampleCache) => {
      const type = explicitType || nodeAt.type;

      if (type === 'string') {
        if (options.typeOnly) {
          return '';
        }
        return createWithDefault(nodeAt, isRequired, '', path, parent, key, exampleCache);
      }
      if (type === 'boolean') {
        if (options.typeOnly) {
          return undefined;
        }
        return createWithDefault(nodeAt, isRequired, false, path, parent, key, exampleCache);
      }
      if (type === 'object') {
        if (options.typeOnly) {
          return {};
        }
        return createWithDefault(nodeAt, isRequired, {}, path, parent, key, exampleCache);
      }
      if (type === 'integer') {
        if (options.typeOnly) {
          return undefined;
        }
        return createWithDefault(nodeAt, isRequired, nodeAt.minimum || 0, path, parent, key, exampleCache);
      }
      if (type === 'number') {
        if (options.typeOnly) {
          return undefined;
        }
        return createWithDefault(nodeAt, isRequired, nodeAt.minimum || 0.0, path, parent, key, exampleCache);
      }
      if (type === 'null') {
        if (options.typeOnly) {
          return undefined;
        }

        return createWithDefault(nodeAt, isRequired, null, path, parent, key, exampleCache);
      }
      if (type === 'array') {
        if (options.typeOnly) {
          return [];
        }
        return createWithDefault(nodeAt, isRequired, [], path, parent, key, exampleCache);
      }
      if (Array.isArray(nodeAt.type)) {

        if (options.typeOnly) {
          return undefined;
        }

        const valueType = nodeAt.type.find((vt) => { return valueTypes.includes(vt); });
        return constructValueFromNode(nodeAt, isRequired, valueType || nodeAt.type[0], path, parent, key, exampleCache);
      }
      throw new Error(`unknown type ${type}`);
    };

    const buildEmptyObjectFromSchema = () => {
      if (node && !node.properties) {
        /* intrinsic type (string, number, etc...) */
        return constructValueFromNode(node);
      }
      // node is an object...
      const startAt = node || this;
      const obj = {};
      Schema.walkSubschemaRecursive(startAt.properties, node || null, '', (path, leaf, required, parent, key) => {
        const value = constructValueFromNode(leaf, required, null, path, parent, key, node && node.examples);
        lodash.set(obj, path, value);
      });

      if (options.removeEmptyNodes) {
        // remove anything that isn't required...
        return ObjectUtils.removeEmptyNodes(obj);
      } else {
        return obj;
      }
    };

    return buildEmptyObjectFromSchema();
  }

  /**
   * Determines if a subschema is a match for the specified model
   * 
   * @param {Object} schema the Subschema to create
   * @param {*} value the model to test
   * @return {boolean} true if the schema matches, false if not
   */
  isMatch(schema, value) {
    let types = schema.type;

    if (!Array.isArray(types)) {
      types = [types];
    }

    return types.find((type) => {
      if (type === 'string') {
        return lodash.isString(value);
      }
      if (type === 'boolean') {
        return lodash.isBoolean(value);
      }
      if (type === 'object') {
        return lodash.isObject(value);
      }
      if (type === 'integer') {
        return lodash.isInteger(value);
      }
      if (type === 'number') {
        return lodash.isNumber(value);
      }
      if (type === 'null') {
        return value === null;
      }
      if (type === 'array' && Array.isArray(value)) {
        const items = schema.items;
        // TODO support `anyOf`
        const hasVariant = !!items.oneOf;

        let matches = true;

        value.forEach((i) => {
          if (hasVariant) {
            if (!this.whichSubschema(items, i)) {
              matches = false;
            }
          } else if (!this.isMatch(items, i)) {
            matches = false;
          }
        });

        return matches;
      }
      // no match
      return false;
    });
  }

  /**
   * Determines which subschema to use for a variant array for the specified model
   * 
   * @param {Object} arrSchema the array schema
   * @param {*} value the value to find a schema for
   * @return {?Object} schema
   * @throws {Error} if not an array
   */  
  whichSubschema(arrSchema, value) {
    // TODO support `anyOf`
    if (!arrSchema.items.oneOf) {
      throw new Error('unexpected intrinsic used to determine subschema.');
    }

    const which = arrSchema.items.oneOf.find((one) => {
      let matches = true;

      if (one.type === 'object') {
        Schema.walkSubschemaRecursive(one.properties, one, '', (path, leaf, required) => {
          const v = lodash.get(value, path);

          if (v === undefined && required) {
            matches = false;
          }

          if (v !== undefined && !this.isMatch(leaf, v)) {
            matches = false;
          }

          // this will break out of the cycle if we encounter a something that doesn't match
          return matches;
        });
      } else {
        matches = this.isMatch(one, value);
      }
      return matches;
    });

    return which;
  }

  /**
   * Creates an array element using the specified schema
   * 
   * @param {Object} arrSchema the array schema
   * @param {?Object} variantType a variant type if the array supports variants
   * @return {Object} new array element
   * @throws {Error} if the array is a variant but no variant was specified or the variant is invalid
   */  
  createNewArrayElement(arrSchema, variantType) {
    if (!arrSchema.items) {
      throw new Error('unexpected call to create array element without a def');
    }

    let node;
    // TODO support `anyOf`
    if (arrSchema.items.oneOf) {
      if (!variantType) {
        throw new Error('unspecified type creating array element with type variant...');
      }
      const found = arrSchema.items.oneOf.find((one) => { return one === variantType; });
      if (!found) {
        throw new Error('type not found creating array element with type variant...');
      }
      node = variantType;
    } else {
      node = arrSchema.items;
    }

    if (Array.isArray(node)) {
      // just take the first one...
      node = node[0];
    }

    return this.createDataFromSchema(node);
  }


  /**
   * Hydrates a reference at the specified value
   * 
   * @param {*} value the value to hydrate
   * @param {sting} key the key in the schema which value belongs to
   * @param {Object} context the object we are hydrating
   */
  hydrateReference(value, key, context) {
    const obj = lodash.get(this.schema, SchemaPath.normalizeSchemaReferencePath(value));
    lodash.forOwn(obj, (v, k) => {
      const copy = lodash.cloneDeep(v);
      const source = context[k];
      if (lodash.isObject(source)) {
        context[k] = lodash.merge(
          copy,
          source
        );
      } else if (Array.isArray(source)) {
        context[k] = source.concat(copy);
      } else {
        context[k] = copy;
      }

    });
    // delete the $ref key so we don't rehydrate this reference again
    delete context.$ref;
    return null;
  }


  /**
   * Hydrates references in the schema. This only hydrates internal references. 
   * External reference hydration is not supported.
   * 
   * The reference hydrating is in-place hydration supporting in-document `JSON Schema` references
   * for instance properties only based on 
   * https://spacetelescope.github.io/understanding-json-schema/structuring.html
   * 
   * This is a limited implementation according to 
   * https://stackoverflow.com/questions/17595377/json-schema-regarding-use-of-ref,
   */
  hydrateReferences() {
    // find all `$ref` nodes and replace them with a hydrated reference.
    // keep iterating until we've found them all.
    // This will re-start the search at the top of the schema,
    //    replacing the refs with the hydrated copy of the node, with each iteration.
    // This ensures that rehydrated references that contain refs also get hydrated.
    do {
      while (ObjectUtils.findKeyDeep(this.properties, '$ref', this.hydrateReference.bind(this))) {
        // intentionally blank. all work done in `hydrateReference`
      }
      // check once more to see if there is anything left to hydrate ...
    } while (ObjectUtils.findKeyDeep(this.properties, '$ref'));
  }

  /**
   * Walks the model and invokes the callback 
   * for each value in the model, supplying the specified schema
   * 
   * @param {Object} model 
   * @param {function(subschema:Object, model:*, path:string)} cb Invoked for each value in the model
   */
  walkModel(model, cb) {
    this.walkModelInPlace(this.schema, model, model, '', cb);
  }

  /**
   * Walks the model at the specified subschema
   * for each value in the model, supplying the specified schema
   * 
   * @param {Object} subSchema
   * @param {Object} model 
   * @param {Object} node
   * @param {string} path
   * @param {function(subschema:Object, model:*, path:string)} cb Invoked for each value in the model
   */
  walkModelInPlace(subSchema, model, node, path, cb) {
    cb(subSchema, node, path);

    Schema.walkSubschemaRecursive(subSchema.properties, subSchema, path, (leafPath, leafSchema) => {
      const leafModel = lodash.get(model, leafPath);
      cb(leafSchema, leafModel, leafPath);

      if ((leafSchema.type === 'array') && Array.isArray(lodash.get(model, leafPath))) {
        const arr = lodash.get(model, leafPath);
        const items = leafSchema.items;
        // TODO support `anyOf`
        const hasVariant = !!items.oneOf;

        arr.forEach((item, index) => {
          const arrSchema = hasVariant ?
            this.whichSubschema(leafSchema, item) : items;

          if (arrSchema) {
            this.walkModelInPlace(arrSchema, model, item, `${leafPath}[${index}]`, cb);
          }
        });
      }
    });
  }

  /**
   * Merges the content of the model at the specified path with the specified subschema
   * 
   * @param {*} model 
   * @param {*} path 
   * @param {*} data 
   * @param {*} subSchema 
   * @return {Object} merged model
   */
  mergeWithModelUsingSubschema(model, path, data, subSchema) {
    if (!lodash.get(model, path)) {
      lodash.set(model, path, this.createDataFromSchema(subSchema, {
        typeOnly: true
      }))
    }

    if (subSchema.type === 'array' && !Array.isArray(data)) {
      data = [data];
    }
    return lodash.merge(model, lodash.set({}, path, data));
  }

  /**
   * Walks the model at the specified subschema
   * for each value in the model, supplying the specified schema
   * 
   * @param {Object} value model to validate
   * @throws {SchemaValidationError} 
   */
  validate(value) {
    const validate = ajv.compile(this.schema);
    const valid = validate(value);
    if (!valid) {
      const errors = validate.errors.map((error, index) => {

        const path = error.dataPath.split('.').slice(1).join('.');
        const parentPath = error.dataPath.split('.').slice(1, -1).join('.');
        const key = error.dataPath.split('.').pop().replace(/\[\d{1,}\]/g, '');
        const subschema = this.getSubschemaFromPath(path);
        const label = lodash.get(subschema, '$sprout.ui.label') || key;
        const defaultMessage = `${label} ${error.message}`;
        const message = lodash.get(subschema, '$sprout.ui.message', defaultMessage);
        const errorText = ajv.errorsText([validate.errors[index]]);

        // eslint-disable-next-line no-console
        console.log(`${errorText} @ ${path}`);

        return {
          errorText,
          error,
          subschema,
          parentPath,
          path,
          message
        };
      });
      throw new SchemaValidationError(errors);
    }
  }
}

module.exports = {
  Schema,
  SchemaPath,
  SchemaValidationError,
};
