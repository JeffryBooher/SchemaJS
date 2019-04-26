const lodash = require('lodash');


class ObjectUtils {

  findKeyDeep(obj, key, cb) {

    if (obj === null || typeof obj !== 'object') {
      return undefined;
    }

    // quick check
    if (obj.hasOwnProperty(key)) {
      if (cb) {
        return cb(obj[key], key, obj);
      }
      return obj[key];
    }

    let i = 0;
    if (Array.isArray(obj)) {
      for (i = 0; i < obj.length; i++) {
        const result = this.findKeyDeep(obj[i], key, cb);
        if (result) {
          return result;
        }
      }
    } else {
      const keys = Object.keys(obj);
      for (i = 0; i < keys.length; i++) {
        const result = this.findKeyDeep(obj[keys[i]], key, cb);
        if (result) {
          return result;
        }
      }
    }

    return undefined;
  }

  isEmpty(obj) {
    let result = true;
    if (lodash.isObject(obj)) {
      lodash.forEach(obj, (value) => {
        if (!this.isEmpty(value)) {
          result = false;
        }
      });
    } else if ((!lodash.isUndefined(obj) && !lodash.isNull(obj) && !lodash.isNaN(obj))) {
      if ((obj.length > 0) || (lodash.isBoolean(obj) || lodash.isNumber(obj))) {
        // this considers non-empty arrays to test false...
        //  o[undefined], o[null], o[""], o[[]], o[{v:undefined|null, ""}]
        // if an array has at least one element, it is not considered empty
        result = false;
      }
    }
    return result;
  }

  removeEmptyNodes(o) {
    const obj = lodash.cloneDeep(o);
    lodash.forEach(obj, (value, key) => {
      if (this.isEmpty(value)) {
        delete obj[key];
      } else if (lodash.isObject(value)) {
        obj[key] = this.removeEmptyNodes(value);
      }
    });
    return obj;
  }

  walkObjectRecursive(obj, parent, parentPath, callback) {
    if (obj) {
      Object.keys(obj).forEach((key) => {
        const path = parentPath ? `${parentPath}.${key}` : key,
          value = obj[key];

        const traversalNode = callback(path, value, parent, key);

        if (traversalNode) {
          this.walkObjectRecursive(traversalNode, value, path, callback);
        }
      });
    }
  }

}

module.exports = new ObjectUtils();
