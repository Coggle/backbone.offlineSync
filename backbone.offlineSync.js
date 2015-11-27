
(function() {
  
  var debug = function() {
    console.log.apply(console, ['[offlineSync]'].concat(Array.prototype.slice.call(arguments)));
  };

  Backbone.OfflineSync = {
    offlineStatusCodes: [408, 502, 503, 504]
  };

  var isOffline = function(xhr) {
    return ((xhr.status === 0) ||
            (Backbone.OfflineSync.offlineStatusCodes.indexOf(xhr.status) >= 0));
  }

  var Cache = function() {
    this.storage = window.localStorage || {};
  };

  Cache.prototype.key = function(model) {
    var url = _.result(model, 'url') || (_.result(model, 'urlRoot') + '/' + model.id);
    return '[offline-cache][model]' + url;
  };

  Cache.prototype.groupKey = function(model) {
    return '[offline-cache][collection]' + (_.result(model, 'urlRoot') ||
                                            _.result(model.collection, 'url') ||
                                            _.result(model, 'url').replace('/'+model.id, ''));
  };

  Cache.prototype.get = function(model) {
    if (!this.storage[this.key(model)]) return null;
    var stored = JSON.parse(this.storage[this.key(model)]);
    if (model instanceof Backbone.Collection){
      return _.map(stored, function(value, key) {
        value.temp_id = key;
        return value;
      });
    } else {
      return stored;
    }
  };

  Cache.prototype.markDirty = function(model, state) {
    if (model.isNew()) return;
    if (typeof state === 'undefined') state = true;

    var existingIDs = [];
    if (this.storage[this.groupKey(model)]) {
      existingIDs = JSON.parse(this.storage[this.groupKey(model)]);
    }
    if (state) existingIDs = _.union(existingIDs, [model.id]);
    else existingIDs = _.without(existingIDs, model.id);
    this.storage[this.groupKey(model)] = JSON.stringify(existingIDs);
  };

  Cache.prototype.set = function(model) {
    if (model.isNew()) {
      // models that don't yet have a server-side ID
      // get a client id generated for them
      if (!model.temp_id)
        model.temp_id = 'tmp_'+(Date.now()+'').slice(2)+'_'+(Math.random()+'').slice(2);
      
      var json = this.storage[this.key(model)];
      var modelsAwaitingCreation = json ? JSON.parse(json) : {};
      if (!modelsAwaitingCreation) modelsAwaitingCreation = {};
      modelsAwaitingCreation[model.temp_id] = {
        url: _.result(model, 'url'),
        value: model.toJSON()
      };
      this.storage[this.key(model)] = JSON.stringify(modelsAwaitingCreation);
    } 
    else if(model.hasChanged()) {
      // models that already have an ID and are 
      // modified get stored at the model URL
      var json = this.storage[this.key(model)];
      var record = json ? JSON.parse(json) : {};
      if (!record.value) record.value = {};
      _.extend(record.value, model.changed);
      record.value[model.idAttribute] = model.id;
      record.url = _.result(model, 'url');
      this.storage[this.key(model)] = JSON.stringify(record);
      this.markDirty(model, true);
    }
  };

  Cache.prototype.delete = function(model) {
    if (model.isNew()) this.clear(model);
    else {
      var json = this.storage[this.key(model)];
      var record = json ? JSON.parse(json) : {};
      record.deleted = true;
      this.storage[this.key(model)] = JSON.stringify(record);
      this.markDirty(model, true);
    }
  };

  Cache.prototype.clear = function(model) {
    if (model.isNew() && model.temp_id) {
      var json = this.storage[this.key(model)];
      var modelsAwaitingCreation = json ? JSON.parse(json) : {};
      if (modelsAwaitingCreation) delete modelsAwaitingCreation[model.temp_id];
      this.storage[this.key(model)] = JSON.stringify(modelsAwaitingCreation);
    } 
    else {
      delete this.storage[this.key(model)];
      this.markDirty(model, false);
    }
  };

  Cache.prototype.pending = function(model) {
    
    var newModels = (this.storage[this.key(model)]) ? JSON.parse(this.storage[this.key(model)]) : [];
    newModels = _.map(newModels, function(value, key) {
      value.temp_id = key;
      return value;
    });

    var updatedModels = (this.storage[this.groupKey(model)]) ? JSON.parse(this.storage[this.groupKey(model)]) : [];
    updatedModels = updatedModels.map(function(id){
      model.attributes[model.idAttribute] = id; 
      return JSON.parse(this.storage[this.key(model)]);
    }.bind(this));

    return _.union(newModels, updatedModels);
  };


  var cache = new Cache();

  // intercept error that looks liek they were caused
  // by the server being offline. Any changes get saved
  // in local storage and applied to any reads that happen
  // before the changes eventually make it back to the server
  function suppressOfflineErrors(model, options) {
    if (!options) options = {};
    var _error = options.error;
    options.error = function(xhr) {
      if (isOffline(xhr)) {
        options.error = _error;
        return Backbone.sync('read', model, options);
      }
    };
    return options;
  }

  // intercept success callbacks to clean up the cache
  // when amodel looks liek it's saved ok, clear the locally
  // saved changes
  function cleanupCacheOnSuccess(model, options) {
    if (!options) options = {};
    var _success = options.success;
    options.success = function(data, response, options) {
      options.success = _success;
      cache.clear(model);
      _success(data, response, options);
    };
    return options;
  }

  offlineSync = function(method, model, options) {
    debug('sync', (typeof model.url =='function') ? model.url() : model.url, ':', method, model.cid, model.id, model, options);

    function applyOfflinePatches(backboneModel){
      backboneModel.collection = model.collection || model;
      var record = cache.get(backboneModel);
      if (!record) return backboneModel;
      if (record.deleted) return null;
      var patch = record.value;
      if (patch) for (var k in patch)
        backboneModel.attributes[k] = patch[k];
      return backboneModel;
    }

    switch (method) {
      case 'read':
        var success = options.success;
        options.success = function(data, response, options) {
          // if we're loading a collection, make sure the 
          // temporary IDs we've generated get assigned back 
          // to the backbone version of the model when they're
          // loaded from local storage
          if (model instanceof Backbone.Collection) {
            // apply patches to any existing models
            data = _.compact(data.map(function(existingModel) {
              return applyOfflinePatches(new model.model(existingModel));
            }));
            // and to models that are awaiting creation
            if (cache.get(model)) {
              cache.get(model).map(function(newModel) {
                var asBackboneModel = new model.model(newModel.value);
                asBackboneModel.temp_id = newModel.temp_id;
                data.push(asBackboneModel);
                // models that haven't actually been created yet
                // don't trigger a sync for deletion, so we need
                // to hook in to the event directly to know when
                // they're removed
                asBackboneModel.once('destroy', function() {
                  cache.delete(asBackboneModel);
                });
              });
            }
          }
          // otherwise if it's a model, then apply the any values
          // we've updated since the last save to the server 
          // was successful
          if (model instanceof Backbone.Model) {
            data = applyOfflinePatches(model);
          }
          options.success = success;
          if (success) success(data, response, options);
        };

        Backbone._default_sync(method, model, options);
        break;
      case 'create':
        cache.set(model);
        options = suppressOfflineErrors(model, options);
        options = cleanupCacheOnSuccess(model, options);
        Backbone._default_sync(method, model, options);
        break;
      case 'update':
        cache.set(model);
        options = suppressOfflineErrors(model, options);
        options = cleanupCacheOnSuccess(model, options);
        Backbone._default_sync(method, model, options);
        break;
      case 'delete':
        cache.delete(model);
        options = suppressOfflineErrors(model, options);
        options = cleanupCacheOnSuccess(model, options);
        Backbone._default_sync(method, model, options);
        break;
      default:
        debug('unhandled method', method)
    }
  };

  Backbone._default_sync = Backbone.sync;
  Backbone.sync = offlineSync;


  Backbone.Model.reconcile = function() {
    var Model = this;
    var pending = cache.pending(new Model());
    var models = pending.map(function(pending) {
      var m = new Model(pending.value);
      m.temp_id = pending.temp_id;
      m.url = pending.url;
      return m;
    });

    models.map(function(model) {
      model.save(undefined, {
        success: function() {
          console.log('reconciled ', _.result(model, 'url'));
        },
        error: function(model, xhr) {
          console.log('reconcile failed for', _.result(model, 'url'));
        }
      });
    });
    console.log('reconciling', models);
  };

}).call(this);

