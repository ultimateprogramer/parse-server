// A database adapter that works with data exported from the hosted
// Parse database.

var mongodb = require('mongodb');
var Parse = require('parse/node').Parse;

var Schema = require('./../Schema');
var transform = require('./../transform');

// options can contain:
//   collectionPrefix: the string to put in front of every collection name.
function DatabaseController(adapter, { collectionPrefix } = {}) {
  this.adapter = adapter;

  this.collectionPrefix = collectionPrefix;

  // We don't want a mutable this.schema, because then you could have
  // one request that uses different schemas for different parts of
  // it. Instead, use loadSchema to get a schema.
  this.schemaPromise = null;

  this.connect();
}

// Connects to the database. Returns a promise that resolves when the
// connection is successful.
DatabaseController.prototype.connect = function() {
  return this.adapter.connect();
};

// Returns a promise for a Mongo collection.
// Generally just for internal use.
DatabaseController.prototype.collection = function(className) {
  if (!Schema.classNameIsValid(className)) {
    throw new Parse.Error(Parse.Error.INVALID_CLASS_NAME,
                          'invalid className: ' + className);
  }
  return this.rawCollection(className);
};

DatabaseController.prototype.adaptiveCollection = function(className) {
  return this.adapter.adaptiveCollection(this.collectionPrefix + className);
};

DatabaseController.prototype.collectionExists = function(className) {
  return this.adapter.collectionExists(this.collectionPrefix + className);
};

DatabaseController.prototype.rawCollection = function(className) {
  return this.adapter.collection(this.collectionPrefix + className);
};

DatabaseController.prototype.dropCollection = function(className) {
  return this.adapter.dropCollection(this.collectionPrefix + className);
};

function returnsTrue() {
  return true;
}

// Returns a promise for a schema object.
// If we are provided a acceptor, then we run it on the schema.
// If the schema isn't accepted, we reload it at most once.
DatabaseController.prototype.loadSchema = function(acceptor = returnsTrue) {

  if (!this.schemaPromise) {
    this.schemaPromise = this.collection('_SCHEMA').then((coll) => {
      delete this.schemaPromise;
      return Schema.load(coll);
    });
    return this.schemaPromise;
  }

  return this.schemaPromise.then((schema) => {
    if (acceptor(schema)) {
      return schema;
    }
    this.schemaPromise = this.collection('_SCHEMA').then((coll) => {
      delete this.schemaPromise;
      return Schema.load(coll);
    });
    return this.schemaPromise;
  });
};

// Returns a promise for the classname that is related to the given
// classname through the key.
// TODO: make this not in the DatabaseController interface
DatabaseController.prototype.redirectClassNameForKey = function(className, key) {
  return this.loadSchema().then((schema) => {
    var t = schema.getExpectedType(className, key);
    var match = t.match(/^relation<(.*)>$/);
    if (match) {
      return match[1];
    } else {
      return className;
    }
  });
};

// Uses the schema to validate the object (REST API format).
// Returns a promise that resolves to the new schema.
// This does not update this.schema, because in a situation like a
// batch request, that could confuse other users of the schema.
DatabaseController.prototype.validateObject = function(className, object, query) {
  return this.loadSchema().then((schema) => {
    return schema.validateObject(className, object, query);
  });
};

// Like transform.untransformObject but you need to provide a className.
// Filters out any data that shouldn't be on this REST-formatted object.
DatabaseController.prototype.untransformObject = function(
  schema, isMaster, aclGroup, className, mongoObject) {
  var object = transform.untransformObject(schema, className, mongoObject);

  if (className !== '_User') {
    return object;
  }

  if (isMaster || (aclGroup.indexOf(object.objectId) > -1)) {
    return object;
  }

  delete object.authData;
  delete object.sessionToken;
  return object;
};

// Runs an update on the database.
// Returns a promise for an object with the new values for field
// modifications that don't know their results ahead of time, like
// 'increment'.
// Options:
//   acl:  a list of strings. If the object to be updated has an ACL,
//         one of the provided strings must provide the caller with
//         write permissions.
DatabaseController.prototype.update = function(className, query, update, options) {
  var acceptor = function(schema) {
    return schema.hasKeys(className, Object.keys(query));
  };
  var isMaster = !('acl' in options);
  var aclGroup = options.acl || [];
  var mongoUpdate, schema;
  return this.loadSchema(acceptor)
    .then(s => {
      schema = s;
      if (!isMaster) {
        return schema.validatePermission(className, aclGroup, 'update');
      }
      return Promise.resolve();
    })
    .then(() => this.handleRelationUpdates(className, query.objectId, update))
    .then(() => this.adaptiveCollection(className))
    .then(collection => {
      var mongoWhere = transform.transformWhere(schema, className, query);
      if (options.acl) {
        var writePerms = [
          {_wperm: {'$exists': false}}
        ];
        for (var entry of options.acl) {
          writePerms.push({_wperm: {'$in': [entry]}});
        }
        mongoWhere = {'$and': [mongoWhere, {'$or': writePerms}]};
      }
      mongoUpdate = transform.transformUpdate(schema, className, update);
      return collection.findOneAndUpdate(mongoWhere, mongoUpdate);
    })
    .then(result => {
      if (!result) {
        return Promise.reject(new Parse.Error(Parse.Error.OBJECT_NOT_FOUND,
          'Object not found.'));
      }

      let response = {};
      let inc = mongoUpdate['$inc'];
      if (inc) {
        Object.keys(inc).forEach(key => {
          response[key] = result[key];
        });
      }
      return response;
    });
};

// Processes relation-updating operations from a REST-format update.
// Returns a promise that resolves successfully when these are
// processed.
// This mutates update.
DatabaseController.prototype.handleRelationUpdates = function(className,
                                                         objectId,
                                                         update) {
  var pending = [];
  var deleteMe = [];
  objectId = update.objectId || objectId;

  var process = (op, key) => {
    if (!op) {
      return;
    }
    if (op.__op == 'AddRelation') {
      for (var object of op.objects) {
        pending.push(this.addRelation(key, className,
                                      objectId,
                                      object.objectId));
      }
      deleteMe.push(key);
    }

    if (op.__op == 'RemoveRelation') {
      for (var object of op.objects) {
        pending.push(this.removeRelation(key, className,
                                         objectId,
                                         object.objectId));
      }
      deleteMe.push(key);
    }

    if (op.__op == 'Batch') {
      for (var x of op.ops) {
        process(x, key);
      }
    }
  };

  for (var key in update) {
    process(update[key], key);
  }
  for (var key of deleteMe) {
    delete update[key];
  }
  return Promise.all(pending);
};

// Adds a relation.
// Returns a promise that resolves successfully iff the add was successful.
DatabaseController.prototype.addRelation = function(key, fromClassName,
                                               fromId, toId) {
  var doc = {
    relatedId: toId,
    owningId: fromId
  };
  var className = '_Join:' + key + ':' + fromClassName;
  return this.collection(className).then((coll) => {
    return coll.update(doc, doc, {upsert: true});
  });
};

// Removes a relation.
// Returns a promise that resolves successfully iff the remove was
// successful.
DatabaseController.prototype.removeRelation = function(key, fromClassName,
                                                  fromId, toId) {
  var doc = {
    relatedId: toId,
    owningId: fromId
  };
  var className = '_Join:' + key + ':' + fromClassName;
  return this.collection(className).then((coll) => {
    return coll.remove(doc);
  });
};

// Removes objects matches this query from the database.
// Returns a promise that resolves successfully iff the object was
// deleted.
// Options:
//   acl:  a list of strings. If the object to be updated has an ACL,
//         one of the provided strings must provide the caller with
//         write permissions.
DatabaseController.prototype.destroy = function(className, query, options = {}) {
  var isMaster = !('acl' in options);
  var aclGroup = options.acl || [];

  var schema;
  return this.loadSchema().then((s) => {
    schema = s;
    if (!isMaster) {
      return schema.validatePermission(className, aclGroup, 'delete');
    }
    return Promise.resolve();
  }).then(() => {

    return this.collection(className);
  }).then((coll) => {
    var mongoWhere = transform.transformWhere(schema, className, query);

    if (options.acl) {
      var writePerms = [
        {_wperm: {'$exists': false}}
      ];
      for (var entry of options.acl) {
        writePerms.push({_wperm: {'$in': [entry]}});
      }
      mongoWhere = {'$and': [mongoWhere, {'$or': writePerms}]};
    }

    return coll.remove(mongoWhere);
  }).then((resp) => {
    //Check _Session to avoid changing password failed without any session.
    if (resp.result.n === 0 && className !== "_Session") {
      return Promise.reject(
        new Parse.Error(Parse.Error.OBJECT_NOT_FOUND,
                        'Object not found.'));

    }
  }, (error) => {
    throw error;
  });
};

// Inserts an object into the database.
// Returns a promise that resolves successfully iff the object saved.
DatabaseController.prototype.create = function(className, object, options) {
  var schema;
  var isMaster = !('acl' in options);
  var aclGroup = options.acl || [];

  return this.loadSchema().then((s) => {
    schema = s;
    if (!isMaster) {
      return schema.validatePermission(className, aclGroup, 'create');
    }
    return Promise.resolve();
  }).then(() => {

    return this.handleRelationUpdates(className, null, object);
  }).then(() => {
    return this.collection(className);
  }).then((coll) => {
    var mongoObject = transform.transformCreate(schema, className, object);
    return coll.insert([mongoObject]);
  });
};

// Runs a mongo query on the database.
// This should only be used for testing - use 'find' for normal code
// to avoid Mongo-format dependencies.
// Returns a promise that resolves to a list of items.
DatabaseController.prototype.mongoFind = function(className, query, options = {}) {
  return this.adaptiveCollection(className)
    .then(collection => collection.find(query, options));
};

// Deletes everything in the database matching the current collectionPrefix
// Won't delete collections in the system namespace
// Returns a promise.
DatabaseController.prototype.deleteEverything = function() {
  this.schemaPromise = null;

  return this.adapter.collectionsContaining(this.collectionPrefix).then(collections => {
    let promises = collections.map(collection => {
      return collection.drop();
    });
    return Promise.all(promises);
  });
};

// Finds the keys in a query. Returns a Set. REST format only
function keysForQuery(query) {
  var sublist = query['$and'] || query['$or'];
  if (sublist) {
    let answer = sublist.reduce((memo, subquery) => {
      return memo.concat(keysForQuery(subquery));
    }, []);

    return new Set(answer);
  }

  return new Set(Object.keys(query));
}

// Returns a promise for a list of related ids given an owning id.
// className here is the owning className.
DatabaseController.prototype.relatedIds = function(className, key, owningId) {
  return this.adaptiveCollection(joinTableName(className, key))
    .then(coll => coll.find({owningId : owningId}))
    .then(results => results.map(r => r.relatedId));
};

// Returns a promise for a list of owning ids given some related ids.
// className here is the owning className.
DatabaseController.prototype.owningIds = function(className, key, relatedIds) {
  return this.adaptiveCollection(joinTableName(className, key))
    .then(coll => coll.find({ relatedId: { '$in': relatedIds } }))
    .then(results => results.map(r => r.owningId));
};

// Modifies query so that it no longer has $in on relation fields, or
// equal-to-pointer constraints on relation fields.
// Returns a promise that resolves when query is mutated
DatabaseController.prototype.reduceInRelation = function(className, query, schema) {
  
  // Search for an in-relation or equal-to-relation
  // Make it sequential for now, not sure of paralleization side effects
  if (query['$or']) {
    let ors = query['$or'];
    return Promise.all(ors.map((aQuery, index) => {
      return this.reduceInRelation(className, aQuery, schema).then((aQuery) => {
        query['$or'][index] = aQuery; 
      })
    }));
  }

  let promises = Object.keys(query).map((key) => {
    if (query[key] && (query[key]['$in'] || query[key].__type == 'Pointer')) {
      let t = schema.getExpectedType(className, key);
      let match = t ? t.match(/^relation<(.*)>$/) : false;
      if (!match) {
        return Promise.resolve(query);
      }
      let relatedClassName = match[1];
      let relatedIds;
      if (query[key]['$in']) {
        relatedIds = query[key]['$in'].map(r => r.objectId);
      } else {
        relatedIds = [query[key].objectId];
      }
      return this.owningIds(className, key, relatedIds).then((ids) => {
        delete query[key];
        query.objectId = Object.assign({'$in': []}, query.objectId);
        query.objectId['$in'] = query.objectId['$in'].concat(ids);
        return Promise.resolve(query);
      });
    }
    return Promise.resolve(query);
  })
  
  return Promise.all(promises).then(() => {
    return Promise.resolve(query);
  })
};

// Modifies query so that it no longer has $relatedTo
// Returns a promise that resolves when query is mutated
DatabaseController.prototype.reduceRelationKeys = function(className, query) {
  
  if (query['$or']) {
    return Promise.all(query['$or'].map((aQuery) => {
      return this.reduceRelationKeys(className, aQuery);
    }));
  }
  
  var relatedTo = query['$relatedTo'];
  if (relatedTo) {
    return this.relatedIds(
      relatedTo.object.className,
      relatedTo.key,
      relatedTo.object.objectId).then((ids) => {
        delete query['$relatedTo'];
        query.objectId = query.objectId || {};
        let queryIn = query.objectId['$in'] || [];
        queryIn = queryIn.concat(ids);
        query['objectId'] = {'$in': queryIn};
        return this.reduceRelationKeys(className, query);
      });
  }
};

// Runs a query on the database.
// Returns a promise that resolves to a list of items.
// Options:
//   skip    number of results to skip.
//   limit   limit to this number of results.
//   sort    an object where keys are the fields to sort by.
//           the value is +1 for ascending, -1 for descending.
//   count   run a count instead of returning results.
//   acl     restrict this operation with an ACL for the provided array
//           of user objectIds and roles. acl: null means no user.
//           when this field is not present, don't do anything regarding ACLs.
// TODO: make userIds not needed here. The db adapter shouldn't know
// anything about users, ideally. Then, improve the format of the ACL
// arg to work like the others.
DatabaseController.prototype.find = function(className, query, options = {}) {
  var mongoOptions = {};
  if (options.skip) {
    mongoOptions.skip = options.skip;
  }
  if (options.limit) {
    mongoOptions.limit = options.limit;
  }

  var isMaster = !('acl' in options);
  var aclGroup = options.acl || [];
  var acceptor = function(schema) {
    return schema.hasKeys(className, keysForQuery(query));
  };
  var schema;
  return this.loadSchema(acceptor).then((s) => {
    schema = s;
    if (options.sort) {
      mongoOptions.sort = {};
      for (var key in options.sort) {
        var mongoKey = transform.transformKey(schema, className, key);
        mongoOptions.sort[mongoKey] = options.sort[key];
      }
    }

    if (!isMaster) {
      var op = 'find';
      var k = Object.keys(query);
      if (k.length == 1 && typeof query.objectId == 'string') {
        op = 'get';
      }
      return schema.validatePermission(className, aclGroup, op);
    }
    return Promise.resolve();
  }).then(() => {
    return this.reduceRelationKeys(className, query);
  }).then(() => {
    return this.reduceInRelation(className, query, schema);
  }).then(() => {
    return this.adaptiveCollection(className);
  }).then(collection => {
    var mongoWhere = transform.transformWhere(schema, className, query);
    if (!isMaster) {
      var orParts = [
        {"_rperm" : { "$exists": false }},
        {"_rperm" : { "$in" : ["*"]}}
      ];
      for (var acl of aclGroup) {
        orParts.push({"_rperm" : { "$in" : [acl]}});
      }
      mongoWhere = {'$and': [mongoWhere, {'$or': orParts}]};
    }
    if (options.count) {
      return collection.count(mongoWhere, mongoOptions);
    } else {
      return collection.find(mongoWhere, mongoOptions)
        .then((mongoResults) => {
          return mongoResults.map((r) => {
            return this.untransformObject(
              schema, isMaster, aclGroup, className, r);
          });
        });
    }
  });
};

function joinTableName(className, key) {
  return `_Join:${key}:${className}`;
}

module.exports = DatabaseController;
