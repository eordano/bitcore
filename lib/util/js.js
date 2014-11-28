'use strict';

var _ = require('lodash');

/**
 * Determines whether a string contains only hexadecimal values
 *
 * @param {string} value
 * @return {boolean} true if the string is the hexa representation of a number
 */
var isHexa = function isHexa(value) {
  if (!_.isString(value)) {
    return false;
  }
  return /^[0-9a-fA-F]+$/.test(value);
};

module.exports = {
  /**
   * Test if an argument is a valid JSON object. If it is, returns a truthy
   * value (the json object decoded), so no double JSON.parse call is necessary
   *
   * @param {string} arg
   * @return {Object|boolean} false if the argument is not a JSON string.
   */
  isValidJson: function isValidJson(arg) {
    try {
      return JSON.parse(arg);
    } catch (e) {
      return false;
    }
  },
  isHexa: isHexa,
  isHexaString: isHexa
};
