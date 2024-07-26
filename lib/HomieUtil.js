'use strict';

module.exports = class HomieUtil {

  static homeyTypeToHomieDatatype(homeyType) {
    switch (homeyType) {
      case 'number': return 'integer';
      case 'string': return 'string';
      case 'boolean': return 'boolean';
      case 'enum': return 'enum';
      default: return null;
    }
  }

}