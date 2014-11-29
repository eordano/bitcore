'use strict';


var assert = require('assert');
var buffer = require('buffer');
var _ = require('lodash');

var BN = require('./crypto/bn');
var Base58 = require('./encoding/base58');
var Base58Check = require('./encoding/base58check');
var Hash = require('./crypto/hash');
var Network = require('./networks');
var HDKeyCache = require('./hdkeycache');
var Point = require('./crypto/point');
var PrivateKey = require('./privatekey');
var Random = require('./crypto/random');

var inherits = require('inherits');
var bufferUtil = require('./util/buffer');
var jsUtil = require('./util/js');

var MINIMUM_ENTROPY_BITS = 128;
var BITS_TO_BYTES = 1/8;
var MAXIMUM_ENTROPY_BITS = 512;


/**
 * Represents an instance of an hierarchically derived private key.
 *
 * More info on https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
 *
 * @constructor
 * @param {string|Buffer|Object} arg
 */
function HDPrivateKey(arg) {
  /* jshint maxcomplexity: 10 */
  if (arg instanceof HDPrivateKey) {
    return arg;
  }
  if (!(this instanceof HDPrivateKey)) {
    return new HDPrivateKey(arg);
  }
  if (arg) {
    if (_.isString(arg) || bufferUtil.isBuffer(arg)) {
      if (HDPrivateKey.isValidSerialized(arg)) {
        this._buildFromSerialized(arg);
      } else if (jsUtil.isValidJson(arg)) {
        this._buildFromJson(arg);
      } else {
        throw HDPrivateKey.getSerializedError(arg);
      }
    } else {
      if (_.isObject(arg)) {
        this._buildFromObject(arg);
      } else {
        throw new HDPrivateKey.Error.UnrecognizedArgument(arg);
      }
    }
  } else {
    return this._generateRandomly();
  }
}

/**
 * Get a derivated child based on a string or number.
 *
 * If the first argument is a string, it's parsed as the full path of
 * derivation. Valid values for this argument include "m" (which returns the
 * same private key), "m/0/1/40/2'/1000", where the ' quote means a hardened
 * derivation.
 *
 * If the first argument is a number, the child with that index will be
 * derived. If the second argument is truthy, the hardened version will be
 * derived. See the example usage for clarification.
 *
 * @example
 * var parent = new HDPrivateKey('xprv...');
 * var child_0_1_2h = parent.derive(0).derive(1).derive(2, true);
 * var copy_of_child_0_1_2h = parent.derive("m/0/1/2'");
 * assert(child_0_1_2h.xprivkey === copy_of_child_0_1_2h);
 *
 * @param {string|number} arg
 * @param {boolean?} hardened
 */
HDPrivateKey.prototype.derive = function(arg, hardened) {
  if (_.isNumber(arg)) {
    return this._deriveWithNumber(arg, hardened);
  } else if (_.isString(arg)) {
    return this._deriveFromString(arg);
  } else {
    throw new HDPrivateKey.Error.InvalidDerivationArgument(arg);
  }
};

HDPrivateKey.prototype._deriveWithNumber = function(index, hardened) {
  /* jshint maxstatements: 20 */
  /* jshint maxcomplexity: 10 */
  if (index >= HDPrivateKey.Hardened) {
    hardened = true;
  }
  if (index < HDPrivateKey.Hardened && hardened) {
    index += HDPrivateKey.Hardened;
  }
  var cached = HDKeyCache.get(this.xprivkey, index, hardened);
  if (cached) {
    return cached;
  }

  var indexBuffer = bufferUtil.integerAsBuffer(index);
  var data;
  if (hardened) {
    data = bufferUtil.concat([new buffer.Buffer([0]), this.privateKey.toBuffer(), indexBuffer]);
  } else {
    data = bufferUtil.concat([this.publicKey.toBuffer(), indexBuffer]);
  }
  var hash = Hash.sha512hmac(data, this._buffers.chainCode);
  var leftPart = BN().fromBuffer(hash.slice(0, 32), {size: 32});
  var chainCode = hash.slice(32, 64);

  var privateKey = leftPart.add(this.privateKey.toBigNumber()).mod(Point.getN()).toBuffer({size: 32});

  var derived = new HDPrivateKey({
    network: this.network,
    depth: this.depth + 1,
    parentFingerPrint: this.fingerPrint,
    childIndex: index,
    chainCode: chainCode,
    privateKey: privateKey
  });
  HDKeyCache.set(this.xprivkey, index, hardened, derived);
  return derived;
};

HDPrivateKey.prototype._deriveFromString = function(path) {
  var steps = path.split('/');

  // Special cases:
  if (_.contains(HDPrivateKey.RootElementAlias, path)) {
    return this;
  }
  if (!_.contains(HDPrivateKey.RootElementAlias, steps[0])) {
    throw new HDPrivateKey.Error.InvalidPath(path);
  }
  steps = steps.slice(1);

  var result = this;
  for (var step in steps) {
    var index = parseInt(steps[step]);
    var hardened = steps[step] !== index.toString();
    result = result._deriveWithNumber(index, hardened);
  }
  return result;
};

/**
 * Verifies that a given serialized private key in base58 with checksum format
 * is valid.
 *
 * @param {string|Buffer} data - the serialized private key
 * @param {string|Network=} network - optional, if present, checks that the
 *     network provided matches the network serialized.
 * @return {boolean}
 */
HDPrivateKey.isValidSerialized = function(data, network) {
  return !HDPrivateKey.getSerializedError(data, network);
};

/**
 * Checks what's the error that causes the validation of a serialized private key
 * in base58 with checksum to fail.
 *
 * @param {string|Buffer} data - the serialized private key
 * @param {string|Network=} network - optional, if present, checks that the
 *     network provided matches the network serialized.
 * @return {HDPrivateKey.Error.InvalidArgument|null}
 */
HDPrivateKey.getSerializedError = function(data, network) {
  /* jshint maxcomplexity: 10 */
  if (!(_.isString(data) || bufferUtil.isBuffer(data))) {
    return new HDPrivateKey.Error.InvalidArgument('Expected string or buffer');
  }
  if (!Base58.validCharacters(data)) {
    return new HDPrivateKey.Error.InvalidB58Char('(unknown)', data);
  }
  try {
    data = Base58Check.decode(data);
  } catch (e) {
    return new HDPrivateKey.Error.InvalidB58Checksum(data);
  }
  if (data.length !== HDPrivateKey.DataLength) {
    return new HDPrivateKey.Error.InvalidLength(data);
  }
  if (!_.isUndefined(network)) {
    var error = HDPrivateKey._validateNetwork(data, network);
    if (error) {
      return error;
    }
  }
  return null;
};

HDPrivateKey._validateNetwork = function(data, networkArg) {
  var network = Network.get(networkArg);
  if (!network) {
    return new HDPrivateKey.Error.InvalidNetworkArgument(networkArg);
  }
  var version = data.slice(0, 4);
  if (bufferUtil.integerFromBuffer(version) !== network.xprivkey) {
    return new HDPrivateKey.Error.InvalidNetwork(version);
  }
  return null;
};

HDPrivateKey.prototype._buildFromJson = function(arg) {
  return this._buildFromObject(JSON.parse(arg));
};

HDPrivateKey.prototype._buildFromObject = function(arg) {
  /* jshint maxcomplexity: 12 */
  // TODO: Type validation
  var buffers = {
    version: arg.network ? bufferUtil.integerAsBuffer(Network.get(arg.network).xprivkey) : arg.version,
    depth: bufferUtil.integerAsSingleByteBuffer(arg.depth),
    parentFingerPrint: _.isNumber(arg.parentFingerPrint) ? bufferUtil.integerAsBuffer(arg.parentFingerPrint) : arg.parentFingerPrint,
    childIndex: _.isNumber(arg.childIndex) ? bufferUtil.integerAsBuffer(arg.childIndex) : arg.childIndex,
    chainCode: _.isString(arg.chainCode) ? bufferUtil.hexToBuffer(arg.chainCode) : arg.chainCode,
    privateKey: (_.isString(arg.privateKey) && jsUtil.isHexa(arg.privateKey)) ? bufferUtil.hexToBuffer(arg.privateKey) : arg.privateKey,
    checksum: arg.checksum ? (arg.checksum.length ? arg.checksum : bufferUtil.integerAsBuffer(arg.checksum)) : undefined
  };
  return this._buildFromBuffers(buffers);
};

HDPrivateKey.prototype._buildFromSerialized = function(arg) {
  var decoded = Base58Check.decode(arg);
  var buffers = {
    version: decoded.slice(HDPrivateKey.VersionStart, HDPrivateKey.VersionEnd),
    depth: decoded.slice(HDPrivateKey.DepthStart, HDPrivateKey.DepthEnd),
    parentFingerPrint: decoded.slice(HDPrivateKey.ParentFingerPrintStart,
                                     HDPrivateKey.ParentFingerPrintEnd),
    childIndex: decoded.slice(HDPrivateKey.ChildIndexStart, HDPrivateKey.ChildIndexEnd),
    chainCode: decoded.slice(HDPrivateKey.ChainCodeStart, HDPrivateKey.ChainCodeEnd),
    privateKey: decoded.slice(HDPrivateKey.PrivateKeyStart, HDPrivateKey.PrivateKeyEnd),
    checksum: decoded.slice(HDPrivateKey.ChecksumStart, HDPrivateKey.ChecksumEnd),
    xprivkey: arg
  };
  return this._buildFromBuffers(buffers);
};

HDPrivateKey.prototype._generateRandomly = function(network) {
  return HDPrivateKey.fromSeed(Random.getRandomBuffer(64), network);
};

/**
 * Generate a private key from a seed, as described in BIP32
 *
 * @param {string|Buffer} hexa
 * @param {*} network
 * @return HDPrivateKey
 */
HDPrivateKey.fromSeed = function(hexa, network) {
  /* jshint maxcomplexity: 8 */

  if (jsUtil.isHexaString(hexa)) {
    hexa = bufferUtil.hexToBuffer(hexa);
  }
  if (!Buffer.isBuffer(hexa)) {
    throw new HDPrivateKey.Error.InvalidEntropyArgument(hexa);
  }
  if (hexa.length < MINIMUM_ENTROPY_BITS * BITS_TO_BYTES) {
    throw new HDPrivateKey.Error.NotEnoughEntropy(hexa);
  }
  if (hexa.length > MAXIMUM_ENTROPY_BITS * BITS_TO_BYTES) {
    throw new HDPrivateKey.Error.TooMuchEntropy(hexa);
  }
  var hash = Hash.sha512hmac(hexa, new buffer.Buffer('Bitcoin seed'));

  return new HDPrivateKey({
    network: Network.get(network) || Network.livenet,
    depth: 0,
    parentFingerPrint: 0,
    childIndex: 0,
    privateKey: hash.slice(0, 32),
    chainCode: hash.slice(32, 64)
  });
};

/**
 * Receives a object with buffers in all the properties and populates the
 * internal structure
 *
 * @param {Object} arg
 * @param {buffer.Buffer} arg.version
 * @param {buffer.Buffer} arg.depth
 * @param {buffer.Buffer} arg.parentFingerPrint
 * @param {buffer.Buffer} arg.childIndex
 * @param {buffer.Buffer} arg.chainCode
 * @param {buffer.Buffer} arg.privateKey
 * @param {buffer.Buffer} arg.checksum
 * @param {string=} arg.xprivkey - if set, don't recalculate the base58
 *      representation
 * @return {HDPrivateKey} this
 */
HDPrivateKey.prototype._buildFromBuffers = function(arg) {
  /* jshint maxcomplexity: 8 */
  /* jshint maxstatements: 20 */

  HDPrivateKey._validateBufferArguments(arg);
  this._buffers = arg;

  var sequence = [
    arg.version, arg.depth, arg.parentFingerPrint, arg.childIndex, arg.chainCode,
    bufferUtil.emptyBuffer(1), arg.privateKey
  ];
  var concat = buffer.Buffer.concat(sequence);
  if (!arg.checksum || !arg.checksum.length) {
    arg.checksum = Base58Check.checksum(concat);
  } else {
    if (arg.checksum.toString() !== Base58Check.checksum(concat).toString()) {
      throw new HDPrivateKey.Error.InvalidB58Checksum(concat);
    }
  }

  if (!arg.xprivkey) {
    this.xprivkey = Base58Check.encode(buffer.Buffer.concat(sequence));
  } else {
    this.xprivkey = arg.xprivkey;
  }
  this.network = Network.get(bufferUtil.integerFromBuffer(arg.version));
  this.depth = bufferUtil.integerFromSingleByteBuffer(arg.depth);
  this.privateKey = new PrivateKey(BN().fromBuffer(arg.privateKey));
  this.publicKey = this.privateKey.toPublicKey();

  this.fingerPrint = Hash.sha256ripemd160(this.publicKey.toBuffer()).slice(0, HDPrivateKey.ParentFingerPrintSize);

  var HDPublicKey = require('./hdpublickey');
  this.hdPublicKey = new HDPublicKey(this);
  this.xpubkey = this.hdPublicKey.xpubkey;

  return this;
};

HDPrivateKey._validateBufferArguments = function(arg) {
  var checkBuffer = function(name, size) {
    var buff = arg[name];
    assert(bufferUtil.isBuffer(buff), name + ' argument is not a buffer');
    assert(
      buff.length === size,
      name + ' has not the expected size: found ' + buff.length + ', expected ' + size
    );
  };
  checkBuffer('version', HDPrivateKey.VersionSize);
  checkBuffer('depth', HDPrivateKey.DepthSize);
  checkBuffer('parentFingerPrint', HDPrivateKey.ParentFingerPrintSize);
  checkBuffer('childIndex', HDPrivateKey.ChildIndexSize);
  checkBuffer('chainCode', HDPrivateKey.ChainCodeSize);
  checkBuffer('privateKey', HDPrivateKey.PrivateKeySize);
  if (arg.checksum && arg.checksum.length) {
    checkBuffer('checksum', HDPrivateKey.CheckSumSize);
  }
};

/**
 * Returns the string representation of this private key (a string starting
 * with "xprv..."
 *
 * @return string
 */
HDPrivateKey.prototype.toString = function() {
  return this.xprivkey;
};

/**
 * Returns a plain object with a representation of this private key.
 *
 * Fields include:
 *  * network: either 'livenet' or 'testnet'
 *  * depth: a number ranging from 0 to 255
 *  * fingerPrint: a number ranging from 0 to 2^32-1, taken from the hash of the
 *        associated public key
 *  * parentFingerPrint: a number ranging from 0 to 2^32-1, taken from the hash
 *        of this parent's associated public key or zero.
 *  * childIndex: the index from which this child was derived (or zero)
 *  * chainCode: an hexa string representing a number used in the derivation
 *  * privateKey: the private key associated, in hexa representation
 *  * xprivkey: the representation of this extended private key in checksum
 *        base58 format
 *  * checksum: the base58 checksum of xprivkey
 *
 *  @return {Object}
 */
HDPrivateKey.prototype.toObject = function() {
  return {
    network: Network.get(bufferUtil.integerFromBuffer(this._buffers.version)).name,
    depth: bufferUtil.integerFromSingleByteBuffer(this._buffers.depth),
    fingerPrint: bufferUtil.integerFromBuffer(this.fingerPrint),
    parentFingerPrint: bufferUtil.integerFromBuffer(this._buffers.parentFingerPrint),
    childIndex: bufferUtil.integerFromBuffer(this._buffers.childIndex),
    chainCode: bufferUtil.bufferToHex(this._buffers.chainCode),
    privateKey: this.privateKey.toBuffer().toString('hex'),
    checksum: bufferUtil.integerFromBuffer(this._buffers.checksum),
    xprivkey: this.xprivkey
  };
};

/**
 * Returns a string with the results from <tt>toObject</tt>
 *
 * @see {HDPrivateKey#toObject}
 * @return {string}
 */
HDPrivateKey.prototype.toJson = function() {
  return JSON.stringify(this.toObject());
};

HDPrivateKey.DefaultDepth = 0;
HDPrivateKey.DefaultFingerprint = 0;
HDPrivateKey.DefaultChildIndex = 0;
HDPrivateKey.DefaultNetwork = Network.livenet;
HDPrivateKey.Hardened = 0x80000000;
HDPrivateKey.RootElementAlias = ['m', 'M', 'm\'', 'M\''];

HDPrivateKey.VersionSize = 4;
HDPrivateKey.DepthSize = 1;
HDPrivateKey.ParentFingerPrintSize = 4;
HDPrivateKey.ChildIndexSize = 4;
HDPrivateKey.ChainCodeSize = 32;
HDPrivateKey.PrivateKeySize = 32;
HDPrivateKey.CheckSumSize = 4;

HDPrivateKey.DataLength = 78;
HDPrivateKey.SerializedByteSize = 82;

HDPrivateKey.VersionStart           = 0;
HDPrivateKey.VersionEnd             = HDPrivateKey.VersionStart + HDPrivateKey.VersionSize;
HDPrivateKey.DepthStart             = HDPrivateKey.VersionEnd;
HDPrivateKey.DepthEnd               = HDPrivateKey.DepthStart + HDPrivateKey.DepthSize;
HDPrivateKey.ParentFingerPrintStart = HDPrivateKey.DepthEnd;
HDPrivateKey.ParentFingerPrintEnd   = HDPrivateKey.ParentFingerPrintStart + HDPrivateKey.ParentFingerPrintSize;
HDPrivateKey.ChildIndexStart        = HDPrivateKey.ParentFingerPrintEnd;
HDPrivateKey.ChildIndexEnd          = HDPrivateKey.ChildIndexStart + HDPrivateKey.ChildIndexSize;
HDPrivateKey.ChainCodeStart         = HDPrivateKey.ChildIndexEnd;
HDPrivateKey.ChainCodeEnd           = HDPrivateKey.ChainCodeStart + HDPrivateKey.ChainCodeSize;
HDPrivateKey.PrivateKeyStart        = HDPrivateKey.ChainCodeEnd + 1;
HDPrivateKey.PrivateKeyEnd          = HDPrivateKey.PrivateKeyStart + HDPrivateKey.PrivateKeySize;
HDPrivateKey.ChecksumStart          = HDPrivateKey.PrivateKeyEnd;
HDPrivateKey.ChecksumEnd            = HDPrivateKey.ChecksumStart + HDPrivateKey.CheckSumSize;

assert(HDPrivateKey.ChecksumEnd === HDPrivateKey.SerializedByteSize);

HDPrivateKey.Error = function() {
  Error.apply(this, arguments);
};
inherits(HDPrivateKey.Error, Error);

HDPrivateKey.Error.InvalidArgument = function(message) {
  HDPrivateKey.Error.apply(this, arguments);
  this.message = 'Invalid argument: ' + message;
};
inherits(HDPrivateKey.Error.InvalidArgument, TypeError);

HDPrivateKey.Error.InvalidB58Char = function(character, string) {
  HDPrivateKey.Error.InvalidArgument.apply(this, arguments);
  this.message = 'Invalid Base 58 character: ' + character + ' in "' + string + '"';
};
inherits(HDPrivateKey.Error.InvalidB58Char, HDPrivateKey.Error.InvalidArgument);

HDPrivateKey.Error.InvalidB58Checksum = function(message) {
  HDPrivateKey.Error.InvalidArgument.apply(this, arguments);
  this.message = 'Invalid Base 58 checksum in "' + message + '"';
};
inherits(HDPrivateKey.Error.InvalidB58Checksum, HDPrivateKey.Error.InvalidArgument);

HDPrivateKey.Error.InvalidDerivationArgument = function(args) {
  HDPrivateKey.Error.InvalidArgument.apply(this, arguments);
  this.message = 'Invalid derivation argument "' + args + '", expected number and boolean or string';
};
inherits(HDPrivateKey.Error.InvalidDerivationArgument, HDPrivateKey.Error.InvalidArgument);

HDPrivateKey.Error.InvalidEntropyArgument = function(message) {
  HDPrivateKey.Error.InvalidArgument.apply(this, arguments);
  this.message = 'Invalid argument: entropy must be an hexa string or binary buffer, got ' + typeof message;
};
inherits(HDPrivateKey.Error.InvalidEntropyArgument, HDPrivateKey.Error.InvalidArgument);

HDPrivateKey.Error.InvalidLength = function(message) {
  HDPrivateKey.Error.InvalidArgument.apply(this, arguments);
  this.message = 'Invalid length for xprivkey format in "' + message + '"';
};
inherits(HDPrivateKey.Error.InvalidLength, HDPrivateKey.Error.InvalidArgument);

HDPrivateKey.Error.InvalidNetwork = function(network) {
  HDPrivateKey.Error.InvalidArgument.apply(this, arguments);
  this.message = 'Unexpected version for network: got ' + network;
};
inherits(HDPrivateKey.Error.InvalidNetwork, HDPrivateKey.Error.InvalidArgument);

HDPrivateKey.Error.InvalidNetworkArgument = function(message) {
  HDPrivateKey.Error.InvalidArgument.apply(this, arguments);
  this.message = 'Network argument must be \'livenet\' or \'testnet\', got "' + message + '"';
};
inherits(HDPrivateKey.Error.InvalidNetworkArgument, HDPrivateKey.Error.InvalidArgument);

HDPrivateKey.Error.InvalidPath = function(message) {
  HDPrivateKey.Error.InvalidArgument.apply(this, arguments);
  this.message = 'Invalid path for derivation "' + message + '", must start with "m"';
};
inherits(HDPrivateKey.Error.InvalidPath, HDPrivateKey.Error.InvalidArgument);

HDPrivateKey.Error.NotEnoughEntropy = function(message) {
  HDPrivateKey.Error.InvalidEntropyArgument.apply(this, arguments);
  this.message = 'Need more than 128 bytes of entropy, got ' + message.length + ' in "' + message + '"';
};
inherits(HDPrivateKey.Error.NotEnoughEntropy, HDPrivateKey.Error.InvalidEntropyArgument);

HDPrivateKey.Error.TooMuchEntropy = function(message) {
  HDPrivateKey.Error.InvalidEntropyArgument.apply(this, arguments);
  this.message = 'More than 512 bytes of entropy is non standard, got ' + message.length + ' in "' + message + '"';
};
inherits(HDPrivateKey.Error.TooMuchEntropy, HDPrivateKey.Error.InvalidEntropyArgument);

HDPrivateKey.Error.UnrecognizedArgument = function(message) {
  this.message = 'Creating a HDPrivateKey requires a string, a buffer, a json, or an object, got "' + message + '" of type "' + typeof message + '"';
};
inherits(HDPrivateKey.Error.UnrecognizedArgument, HDPrivateKey.Error.InvalidArgument);

module.exports = HDPrivateKey;
