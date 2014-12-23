/**
 * @file gulpfile.js
 *
 * Defines tasks that can be run on gulp.
 *
 * Summary: <ul>
 * <li> `test` - runs all the tests on node and the browser (mocha and karma)
 * <ul>
 * <li> `test:node`
 * <li> `test:node:nofail` - internally used for watching (due to bug on gulp-mocha)
 * <li> `test:browser`
 * </ul>`
 * <li> `watch:test` - watch for file changes and run tests
 * <ul>
 * <li> `watch:test:node`
 * <li> `watch:test:browser`
 * </ul>`
 * <li> `browser` - generate files needed for browser (browserify)
 * <ul>
 * <li> `browser:uncompressed` - build `browser/bitcore.js`
 * <li> `browser:compressed` - build `browser/bitcore.min.js`
 * <li> `browser:maketests` - build `browser/tests.js`, needed for testing without karma
 * </ul>`
 * <li> `errors` - autogenerate the `./lib/errors/index.js` file with error definitions
 * <li> `lint` - run `jshint`
 * <li> `coverage` - run `istanbul` with mocha to generate a report of test coverage
 * <li> `jsdoc` - run `jsdoc` to generate the API reference
 * <li> `coveralls` - updates coveralls info
 * <li> `release` - automates release process (only for bitcore maintainers)
 * </ul>
 */
'use strict';

var gulp = require('gulp');
var coveralls = require('gulp-coveralls');
var jshint = require('gulp-jshint');
var mocha = require('gulp-mocha');
var runSequence = require('run-sequence');
var shell = require('gulp-shell');
var through = require('through2');
var gutil = require('gulp-util');
var jsdoc2md = require('jsdoc-to-markdown');
var mfs = require('more-fs');
var uglify = require('gulp-uglify');
var rename = require('gulp-rename');
var bump = require('gulp-bump');
var git = require('gulp-git');
var tag_version = require('gulp-tag-version');
var pjson = require('./package.json');



var files = ['lib/**/*.js'];
var tests = ['test/**/*.js'];
var alljs = files.concat(tests);


function ignoreError() {
  /* jshint ignore:start */ // using `this` in this context is weird 
  this.emit('end');
  /* jshint ignore:end */
}

var testMocha = function() {
  return gulp.src(tests).pipe(new mocha({
    reporter: 'spec'
  }));
};

var testKarma = shell.task([
  './node_modules/karma/bin/karma start --single-run --browsers Firefox'
]);

/**
 * Testing
 */

gulp.task('test:node', ['errors'], testMocha);

gulp.task('test:node:nofail', ['errors'], function() {
  return testMocha().on('error', ignoreError);
});

gulp.task('test:browser', ['browser:uncompressed', 'browser:maketests'], testKarma);

gulp.task('test', function(callback) {
  runSequence(['test:node'], ['test:browser'], callback);
});

/**
 * File generation
 */

gulp.task('browser:makefolder', shell.task([
  'if [ ! -d "browser" ]; then mkdir browser; fi'
]));

gulp.task('browser:uncompressed', ['browser:makefolder', 'errors'], shell.task([
  './node_modules/.bin/browserify index.js --insert-global-vars=true --standalone=bitcore -o browser/bitcore.js'
]));

gulp.task('browser:compressed', ['browser:uncompressed'], function() {
  return gulp.src('browser/bitcore.js')
    .pipe(uglify({
      mangle: true,
      compress: true
    }))
    .pipe(rename('bitcore.min.js'))
    .pipe(gulp.dest('browser'))
    .on('error', gutil.log);
});

gulp.task('browser:maketests', ['browser:makefolder'], shell.task([
  'find test/ -type f -name "*.js" | xargs ./node_modules/.bin/browserify -t brfs -o browser/tests.js'
]));

gulp.task('browser', ['errors'], function(callback) {
  runSequence(['browser:uncompressed'], ['browser:compressed'], ['browser:maketests'], callback);
});

gulp.task('errors', shell.task([
  'node ./lib/errors/build.js'
]));


/**
 * Code quality and documentation
 */

gulp.task('lint', function() {
  return gulp.src(alljs)
    .pipe(jshint())
    .pipe(jshint.reporter('default'));
});

gulp.task('plato', shell.task(['plato -d report -r -l .jshintrc -t bitcore lib']));

gulp.task('jsdoc', function() {

  function jsdoc() {
    return through.obj(function(file, enc, cb) {

      if (file.isNull()) {
        cb(null, file);
        return;
      }
      if (file.isStream()) {
        cb(new gutil.PluginError('gulp-jsdoc2md', 'Streaming not supported'));
        return;
      }
      var destination = 'docs/api/' + file.path.replace(file.base, '').replace(/\.js$/, '.md');
      jsdoc2md.render(file.path, {})
        .on('error', function(err) {
          gutil.log(gutil.colors.red('jsdoc2md failed', err.message));
        })
        .pipe(mfs.writeStream(destination));
      cb(null, file);
    });
  }

  return gulp.src(files).pipe(jsdoc());

});

gulp.task('coverage', shell.task(['node_modules/.bin/./istanbul cover node_modules/.bin/_mocha -- --recursive']));

gulp.task('coveralls', ['coverage'], function() {
  gulp.src('coverage/lcov.info').pipe(coveralls());
});

/**
 * Watch tasks
 */

gulp.task('watch:test', function() {
  // TODO: Only run tests that are linked to file changes by doing
  // something smart like reading through the require statements
  return gulp.watch(alljs, ['test']);
});

gulp.task('watch:test:node', function() {
  // TODO: Only run tests that are linked to file changes by doing
  // something smart like reading through the require statements
  return gulp.watch(alljs, ['test:node']);
});

gulp.task('watch:test:browser', function() {
  // TODO: Only run tests that are linked to file changes by doing
  // something smart like reading through the require statements
  return gulp.watch(alljs, ['test:browser']);
});

gulp.task('watch:jsdoc', function() {
  // TODO: Only run tests that are linked to file changes by doing
  // something smart like reading through the require statements
  return gulp.watch(alljs, ['jsdoc']);
});

gulp.task('watch:coverage', function() {
  // TODO: Only run tests that are linked to file changes by doing
  // something smart like reading through the require statements
  return gulp.watch(alljs, ['coverage']);
});

gulp.task('watch:lint', function() {
  // TODO: Only lint files that are linked to file changes by doing
  // something smart like reading through the require statements
  return gulp.watch(alljs, ['lint']);
});

gulp.task('watch:browser', function() {
  return gulp.watch(alljs, ['browser']);
});

/**
 * Release automation
 */


gulp.task('release:install', function() {
  return shell.task([
    'npm install',
  ]);
});
gulp.task('release:bump', function() {
  return gulp.src(['./bower.json', './package.json'])
    .pipe(bump({
      type: 'patch'
    }))
    .pipe(gulp.dest('./'));
});
gulp.task('release:commit', function() {
  return gulp.src(['./package.json', './bower.json', './browser/bitcore.js', 'browser/bitcore.min.js'])
    .pipe(git.commit('bumps package version'));
});
gulp.task('release:push', function() {
  git.push('bitpay', 'master', {
    args: ''
  }, function(err) {
    if (err) {
      throw err;
    }
  });
});
gulp.task('release:push-tag', function() {
  git.push('bitpay', 'v' + pjson.version, {
    args: ''
  }, function(err) {
    if (err) {
      throw err;
    }
  });
});

gulp.task('release:tag', function() {
  return gulp.src(['./package.json']).pipe(tag_version());
});


gulp.task('release:publish', shell.task([
  'npm publish'
]));

// requires https://hub.github.com/
gulp.task('release', function(cb) {
  runSequence(
    //run npm install
    ['release:install'],
    //build browser bundle
    ['browser'],
    //run tests with gulp test
    ['test'],
    //update package.json and bower.json
    ['release:bump'],
    //build and deploy new docs
    //[],
    // commit 
    ['release:commit'],
    //push those changes and merge into master in a "version update" PR
    ['release:push'],
    //run git tag -a $VERSION -m '$VERSION' with the new version number
    ['release:tag'],
    //run git push bitpay $VERSION
    ['release:push-tag'],
    //run npm publish
    ['release:publish'],
    cb);
});


/* Default task */
gulp.task('default', function(callback) {
  return runSequence(['lint', 'jsdoc'], ['browser:uncompressed', 'test'], ['coverage', 'browser:compressed'],
    callback);
});
