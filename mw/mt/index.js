'use strict';

var coreModules = require("soajs.core.modules");
var core = coreModules.core;
var provision = coreModules.provision;

var async = require("async");

var regEnvironment = (process.env.SOAJS_ENV || "dev");
regEnvironment = regEnvironment.toLowerCase();

var utils = require("./utils");

/**
 *
 * @param configuration
 * @returns {Function}
 */
module.exports = function (configuration) {
    var soajs = configuration.soajs;
    var param = configuration.param;
    var app = configuration.app;

    return function (req, res, next) {
        /**
         *    TODO: the below are the params that we should turn on per service per env to populate injectObj upon
         *        urac
         *        urac_Profile
         *        urac_ACL
         *        provision_ACL
         *        extKeyRequired ? maybe
         *        oauth
         */
        var serviceInfo = req.soajs.controller.serviceParams.registry.versions[req.soajs.controller.serviceParams.version];
        if(!serviceInfo){
	        return next(133);
        }
        
	    var oauth = true;
	    if(Object.hasOwnProperty.call(serviceInfo, 'oauth')){
		    oauth = serviceInfo.oauth;
	    }
        var serviceParam = {
            "urac": serviceInfo.urac || false,
            "urac_Profile": serviceInfo.urac_Profile || false,
            "urac_ACL": serviceInfo.urac_ACL || false,
            "provision_ACL": serviceInfo.provision_ACL || false,
            "extKeyRequired": serviceInfo.extKeyRequired || false,
            "oauth": oauth
        };
        
        if (serviceInfo.hasOwnProperty("oauth"))
            serviceParam.oauth = serviceInfo.oauth;

        if (serviceInfo[regEnvironment]) {
            if (serviceInfo[regEnvironment].hasOwnProperty("extKeyRequired"))
                serviceParam.extKeyRequired = serviceInfo[regEnvironment].extKeyRequired;
            if (serviceInfo[regEnvironment].hasOwnProperty("oauth"))
                serviceParam.oauth = serviceInfo[regEnvironment].oauth;
        }
        if (serviceParam.extKeyRequired) {
            try {
                provision.getExternalKeyData(req.get("key"), req.soajs.registry.serviceConfig.key, function (err, keyObj) {
                    if (err)
                        req.soajs.log.warn(err);
                    if (keyObj && keyObj.application && keyObj.application.package) {
                        req.soajs.tenant = keyObj.tenant;
                        req.soajs.tenant.key = {
                            "iKey": keyObj.key,
                            "eKey": keyObj.extKey
                        };
                        req.soajs.tenant.application = keyObj.application;
                        provision.getPackageData(keyObj.application.package, function (err, packObj) {
                            if (err)
                                req.soajs.log.warn(err);
                            if (packObj) {
                                req.soajs.tenant.application.package_acl = packObj.acl;
                                req.soajs.tenant.application.package_acl_all_env = packObj.acl_all_env;
                                req.soajs.servicesConfig = keyObj.config;

                                var serviceCheckArray = [function (cb) {
                                    cb(null, {
                                        "app": app,
                                        "soajs": soajs,
                                        "res": res,
                                        "req": req,
                                        "keyObj": keyObj,
                                        "packObj": packObj
                                    });
                                }];

                                serviceCheckArray.push(utils.securityGeoCheck);
                                serviceCheckArray.push(utils.securityDeviceCheck);
                                serviceCheckArray.push(utils.oauthCheck);
                                serviceCheckArray.push(utils.uracCheck);
                                serviceCheckArray.push(utils.serviceCheck);
                                serviceCheckArray.push(utils.apiCheck);

                                async.waterfall(serviceCheckArray, function (err, data) {
                                    if (err)
                                        return next(err);
                                    else {
                                        var serviceName = data.req.soajs.controller.serviceParams.name;
                                        var dataServiceConfig = data.servicesConfig || keyObj.config;
                                        var serviceConfig = {};

                                        if (dataServiceConfig.commonFields) {
                                            for (var i in dataServiceConfig.commonFields) {
                                                //if servicesConfig already has an entry, entry overrides commonFields
                                                if (!serviceConfig[i]) {
                                                    serviceConfig[i] = dataServiceConfig.commonFields[i];
                                                }
                                            }
                                        }

                                        if (dataServiceConfig[serviceName]) {
                                            serviceConfig[serviceName] = dataServiceConfig[serviceName];
                                        }

                                        var injectObj = {
                                            "tenant": {
                                                "id": keyObj.tenant.id,
                                                "code": keyObj.tenant.code,
                                                "roaming": data.req.soajs.tenant.roaming
                                            },
                                            "key": {
                                                /*
                                                 do not send the servicesConfig as it is, it should only send the service and commonFields
                                                 ex:
                                                 serviceConfig = {
                                                 commonFields : { .... },
                                                 [serviceName] : { .... }
                                                 }
                                                 */
                                                "config": serviceConfig,
                                                "iKey": keyObj.key,
                                                "eKey": keyObj.extKey
                                            },
                                            "application": {
                                                "product": keyObj.application.product,
                                                "package": keyObj.application.package,
                                                "appId": keyObj.application.appId,
                                                "acl": keyObj.application.acl,
                                                "acl_all_env": keyObj.application.acl_all_env
                                            },
                                            "package": {
                                                "acl": packObj.acl,
                                                "acl_all_env": packObj.acl_all_env
                                            },
                                            "device": data.device,
                                            "geo": data.geo
                                        };

                                        if (req.soajs.uracDriver) {
                                            if (serviceParam.urac) {
                                                var uracObj = req.soajs.uracDriver.getProfile();
                                                injectObj.urac = {
                                                    "_id": uracObj._id,
                                                    "username": uracObj.username,
                                                    "firstName": uracObj.firstName,
                                                    "lastName": uracObj.lastName,
                                                    "email": uracObj.email,
                                                    "groups": uracObj.groups,
                                                    "socialLogin": uracObj.socialLogin,
	                                                "tenant": {
                                                    	"id": uracObj.tenant.id,
		                                                "code": uracObj.tenant.code
	                                                }
                                                };
	                                            
                                                injectObj.param = injectObj.param || {};
                                                injectObj.param.urac_Profile = serviceParam.urac_Profile;
                                                injectObj.param.urac_ACL = serviceParam.urac_ACL;

                                                if (serviceParam.urac_Profile)
                                                    injectObj.urac.profile = uracObj.profile;
                                                if (serviceParam.urac_ACL)
                                                    injectObj.urac.acl = req.soajs.uracDriver.getAcl();
                                                if (serviceParam.urac_ACL)
                                                    injectObj.urac.acl_AllEnv = req.soajs.uracDriver.getAclAllEnv();
                                            }
                                        }
                                        if (!serviceParam.provision_ACL) {
                                            delete injectObj.application.acl;
                                            delete injectObj.application.acl_all_env;
                                            delete injectObj.package.acl_all_env;
                                            delete injectObj.package.acl;
                                        }

                                        req.headers['soajsinjectobj'] = JSON.stringify(injectObj);

                                        return next();
                                    }
                                });
                            }
                            else
                                return next(152);
                        });
                    }
                    else
                        return next(153);
                });
            } catch (err) {
                req.soajs.log.error(150, err.stack);
                req.soajs.controllerResponse(core.error.getError(150));
            }
        }
        else {
            if (serviceParam.oauth) {
                var oauthExec = function () {
                    soajs.oauth(req, res, next);
                };
                return oauthExec();
            }
            else
                return next();
        }
    };
};
