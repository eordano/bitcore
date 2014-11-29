'use strict';

var inherits = require('inherits');
 
module.exports = {
  /**
    *
    * Will build errors based on a specification
    *
    * @example
    * 
    * var Point = function Point() { ... };
    * var Errors = {}
    *
    * defineErrors(Point.Errors, [
    *   'InvalidY',
    *   'InvalidX'
    * ], TypeError);
    *
    * // throw an error
    * throw new Point.Errors.InvalidY('Invalid y for curve.');
    * 
    * // handle an error
    * if ( error instanceof Point.Errors.InvalidY ) { ... };
    *
    */
  defineErrors: function defineErrors(base, names, type){
    names.forEach(function(name){
      var e = function(message){
        this.message = message;
      };
      e.name = name;
      inherits(e, type);
      Object.defineProperty(base, name, {
        configurable: false,
        value: e
      });
    });
  }
};


