// @ts-check
/* eslint-env node */

const fs = require('fs');
const os = require('os');
const path = require('path');
const SilentError = require('silent-error');
const TsPreprocessor = require('./lib/typescript-preprocessor');
const buildServeCommand = require('./lib/serve-ts');
const funnel = require('broccoli-funnel');
const mergeTrees = require('broccoli-merge-trees');
const mkdirp = require('mkdirp');

module.exports = {
  name: 'ember-cli-typescript',

  _isRunningServeTS() {
    return this.project._isRunningServeTS;
  },

  _tempDir() {
    if (!this.project._tsTempDir) {
      const tempDir = path.join(os.tmpdir(), `e-c-ts-${process.pid}`);
      this.project._tsTempDir = tempDir;
      mkdirp.sync(tempDir);
    }

    return this.project._tsTempDir;
  },

  _inRepoAddons() {
    const pkg = this.project.pkg;
    if (!pkg || !pkg['ember-addon'] || !pkg['ember-addon'].paths) {
      return [];
    }

    return pkg['ember-addon'].paths;
  },

  includedCommands() {
    return {
      'serve-ts': buildServeCommand(this.project, this._tempDir()),
    };
  },

  // Stolen from ember-cli-mirage.
  included() {
    let app;

    // If the addon has the _findHost() method (in ember-cli >= 2.7.0), we'll just
    // use that.
    if (typeof this._findHost === 'function') {
      app = this._findHost();
    } else {
      // Otherwise, we'll use this implementation borrowed from the _findHost()
      // method in ember-cli.
      let current = this;
      do {
        app = current.app || app;
      } while (current.parent.parent && (current = current.parent));
    }

    this.app = app;

    this._super.included.apply(this, arguments);
  },

  treeForApp(tree) {
    const { include } = JSON.parse(
      fs.readFileSync(path.resolve(this.app.project.root, 'tsconfig.json'), { encoding: 'utf8' })
    );

    const includes = ['types']
      .concat(include ? include : [])
      .reduce((unique, entry) => (unique.indexOf(entry) === -1 ? unique.concat(entry) : unique), [])
      .map(p => path.resolve(this.app.project.root, p))
      .filter(fs.existsSync);

    const additionalTrees = includes.map(p => funnel(p, { destDir: p }));

    if (!this._isRunningServeTS()) {
      return mergeTrees([tree, ...additionalTrees]);
    }

    const roots = ['.', ...includes, ...this._inRepoAddons()].map(root => path.join(root, 'app/'));

    // funnel will fail if the directory doesn't exist
    roots.forEach(root => {
      mkdirp.sync(path.join(this._tempDir(), root));
    });

    const ts = funnel(this._tempDir(), {
      exclude: ['tests'],
      getDestinationPath(relativePath) {
        const prefix = roots.find(root => relativePath.startsWith(root));
        if (prefix) {
          // strip any app/ or lib/in-repo-addon/app/ prefix
          return relativePath.substr(prefix.length);
        }

        return relativePath;
      },
    });

    return mergeTrees([tree, ts]);
  },

  treeForTestSupport(tree) {
    if (!this._isRunningServeTS()) {
      return tree;
    }

    const tests = path.join(this._tempDir(), 'tests');

    // funnel will fail if the directory doesn't exist
    mkdirp.sync(tests);

    const ts = funnel(tests);
    return tree ? mergeTrees([tree, ts]) : ts;
  },

  setupPreprocessorRegistry(type, registry) {
    if (!fs.existsSync(path.join(this.project.root, 'tsconfig.json'))) {
      // Do nothing; we just won't have the plugin available. This means that if you
      // somehow end up in a state where it doesn't load, the preprocessor *will*
      // fail, but this is necessary because the preprocessor depends on packages
      // which aren't installed until the default blueprint is run

      this.ui.writeInfoLine(
        'Skipping TypeScript preprocessing as there is no tsconfig.json. ' +
          '(If this is during installation of the add-on, this is as expected. If it is ' +
          'while building, serving, or testing the application, this is an error.)'
      );
      return;
    }

    if (type === 'self' || this._isRunningServeTS()) {
      // TODO: still need to compile TS addons
      return;
    }

    try {
      registry.add(
        'js',
        new TsPreprocessor({
          ui: this.ui,
        })
      );
    } catch (ex) {
      throw new SilentError(
        `Failed to instantiate TypeScript preprocessor, probably due to an invalid tsconfig.json. Please fix or run \`ember generate ember-cli-typescript\`.\n${ex}`
      );
    }
  },
};
