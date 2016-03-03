// global_config.js

var Parse = require('parse/node').Parse;

import PromiseRouter from '../PromiseRouter';
import * as middleware from "../middlewares";

export class GlobalConfigRouter extends PromiseRouter {
  getGlobalConfig(req) {
    return req.config.database.rawCollection('_GlobalConfig')
      .then(coll => coll.findOne({'_id': 1}))
      .then(globalConfig => ({response: { params: globalConfig.params }}))
      .catch(() => ({
        status: 404,
        response: {
          code: Parse.Error.INVALID_KEY_NAME,
          error: 'config does not exist',
        }
      }));
  }
  updateGlobalConfig(req) {
    return req.config.database.rawCollection('_GlobalConfig')
      .then(coll => coll.findOneAndUpdate({ _id: 1 }, { $set: req.body }))
      .then(response => {
        return { response: { result: true } }
      })
      .catch(() => ({
        status: 404,
        response: {
          code: Parse.Error.INVALID_KEY_NAME,
          error: 'config cannot be updated',
        }
     }));
  }
  
  mountRoutes() {
    this.route('GET', '/config', req => { return this.getGlobalConfig(req) });
    this.route('PUT', '/config', middleware.promiseEnforceMasterKeyAccess, req => { return this.updateGlobalConfig(req) });
  }
}

export default GlobalConfigRouter;
