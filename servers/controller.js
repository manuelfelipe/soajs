'use strict';

var connect = require('connect');
var http = require('http');
var request = require('request');
var httpProxy = require('http-proxy');
var url = require('url');

var coreModules = require("soajs.core.modules");
var core = coreModules.core;
var provision = coreModules.provision;

var favicon_mw = require('./../mw/favicon/index');
var cors_mw = require('./../mw/cors/index');
var soajs_mw = require('./../mw/soajs/index');
var response_mw = require('./../mw/response/index');
var enhancer_mw = require('./../mw/enhancer/index');
var awareness_mw = require('./../mw/awareness/index');
var awarenessEnv_mw = require("./../mw/awarenessEnv/index");
var controller_mw = require('./../mw/controller/index');

var autoRegHost = process.env.SOAJS_SRV_AUTOREGISTERHOST || true;
if (autoRegHost && typeof(autoRegHost) !== 'boolean') {
    autoRegHost = (autoRegHost === 'true');
}

/**
 *
 */
function controller(param) {
    var _self = this;
    param = param || {};
    _self.awareness = true;
    _self.serviceName = "controller";
    _self.serviceVersion = 1;
    _self.serviceIp = process.env.SOAJS_SRVIP || null;
    _self.serviceHATask = null;

    //TODO: we might not need bodyParser
    param.bodyParser = false;

    _self.soajs = {"param": param};
}

controller.prototype.init = function (callback) {
    var _self = this;
    var fetchedHostIp = null;
    var serviceIpNotDetected = false;
    if (!autoRegHost && !process.env.SOAJS_DEPLOY_HA) {
        _self.serviceIp = '127.0.0.1';
    }
    if (!_self.serviceIp && !process.env.SOAJS_DEPLOY_HA) {
        core.getHostIp(function (getHostIpResponse) {
            fetchedHostIp = getHostIpResponse;
            if (fetchedHostIp && fetchedHostIp.result) {
                _self.serviceIp = fetchedHostIp.ip;
                if (fetchedHostIp.extra && fetchedHostIp.extra.swarmTask) {
                    _self.serviceHATask = fetchedHostIp.extra.swarmTask;
                }
            } else {
                serviceIpNotDetected = true;
                _self.serviceIp = "127.0.0.1";
            }
            resume();
        });
    }
    else {
        resume();
    }
    function resume() {
        core.registry.load({
            "serviceName": _self.serviceName,
            "serviceVersion": _self.serviceVersion,
            "apiList": null,
            "serviceIp": _self.serviceIp
        }, function (reg) {
            _self.registry = reg;
            _self.log = core.getLogger(_self.serviceName, _self.registry.serviceConfig.logger);
            if (fetchedHostIp) {
                if (!fetchedHostIp.result) {
                    _self.log.warn("Unable to find the service host ip. The service will NOT be registered for awareness.");
                    _self.log.info("IPs found: ", fetchedHostIp.extra.ips);
                    if (serviceIpNotDetected) {
                        _self.log.warn("The default service IP has been used [" + _self.serviceIp + "]");
                    }
                }
                else {
                    _self.log.info("The IP registered for service [" + _self.serviceName + "] awareness : ", fetchedHostIp.ip);
                }
            }

            var app = connect();
            app.use(favicon_mw());
            app.use(soajs_mw({
                "serviceName": _self.serviceName,
                "log": _self.log
            }));
            app.use(cors_mw());
            app.use(response_mw({"controllerResponse": true}));

            _self.log.info("Loading Provision ...");
            provision.init(_self.registry.coreDB.provision, _self.log);
            provision.loadProvision(function (loaded) {
                if (loaded) {
                    _self.log.info("Service provision loaded.");
                    _self.server = http.createServer(app);
                    _self.serverMaintenance = http.createServer(function (req, res) {
                        if (req.url === '/favicon.ico') {
                            res.writeHead(200, {'Content-Type': 'image/x-icon'});
                            return res.end();
                        }
                        var parsedUrl = url.parse(req.url, true);
                        var response;
                        var maintenanceResponse = function (req, route) {
                            var response = {
                                'result': false,
                                'ts': Date.now(),
                                'service': {
                                    'service': _self.serviceName.toUpperCase(),
                                    'type': 'rest',
                                    'route': route || parsedUrl.pathname
                                }
                            };
                            return response;
                        };
                        var reloadRegistry = function () {
                            core.registry.reload({
                                "serviceName": _self.serviceName,
                                "serviceVersion": null,
                                "apiList": null,
                                "serviceIp": _self.serviceIp
                            }, function (err, reg) {
                                res.writeHead(200, {'Content-Type': 'application/json'});
                                response = maintenanceResponse(req);
                                if (err) {
                                    _self.log.warn("Failed to load registry. reusing from previous load. Reason: " + err.message);
                                } else {
                                    response['result'] = true;
                                    response['data'] = reg;
                                }
                                return res.end(JSON.stringify(response));
                            });
                        };

                        var proxy = httpProxy.createProxyServer({});
                        proxy.on('error', function (error, req, res) {
                            _self.log.error('Failed to proxy ' + req.url);
                            _self.log.error('Internal proxy error: ' + error);

                            res.writeHead(200, {'Content-Type': 'application/json'});
                            response = maintenanceResponse(req, '/proxySocket');
                            return res.end(JSON.stringify(response));
                        });

                        if (parsedUrl.pathname === '/reloadRegistry') {
                            reloadRegistry();
                        }
                        else if (parsedUrl.pathname === '/awarenessStat') {
                            res.writeHead(200, {'Content-Type': 'application/json'});
                            var tmp = core.registry.get();
                            response = maintenanceResponse(req);
                            if (tmp && (tmp.services || tmp.daemons)) {
                                response['result'] = true;
                                response['data'] = {"services": tmp.services, "daemons": tmp.daemons};
                            }

                            if (process.env.SOAJS_DEPLOY_HA) {
                                awareness_mw({
                                    "awareness": _self.awareness,
                                    "serviceName": _self.serviceName,
                                    "log": _self.log,
                                    "serviceIp": _self.serviceIp
                                });
                            }

                            return res.end(JSON.stringify(response));
                        }
                        else if (parsedUrl.pathname === '/register') {
                            if (parsedUrl.query.serviceHATask) {
                                reloadRegistry();
                            }
                            else {
                                res.writeHead(200, {'Content-Type': 'application/json'});
                                response = maintenanceResponse(req);
                                var regOptions = {
                                    "name": parsedUrl.query.name,
                                    "group": parsedUrl.query.group,
                                    "port": parseInt(parsedUrl.query.port),
                                    "ip": parsedUrl.query.ip,
                                    "type": parsedUrl.query.type,
                                    "version": parseInt(parsedUrl.query.version)
                                };
                                if (regOptions.type === "service") {
                                    regOptions["oauth"] = (parsedUrl.query.oauth === "false" ? false : true);
                                    regOptions["extKeyRequired"] = (parsedUrl.query.extKeyRequired === "true" ? true : false);
                                    regOptions["requestTimeout"] = parseInt(parsedUrl.query.requestTimeout);
                                    regOptions["requestTimeoutRenewal"] = parseInt(parsedUrl.query.requestTimeoutRenewal);
                                }

                                core.registry.register(
                                    regOptions,
                                    function (err, data) {
                                        if (!err) {
                                            response['result'] = true;
                                            response['data'] = data;
                                        }
                                        else {
                                            _self.log.warn("Failed to register service for [" + parsedUrl.query.name + "] " + err.message);
                                        }
                                        return res.end(JSON.stringify(response));
                                    });
                            }
                        }
                        else if (parsedUrl.pathname.match('/proxySocket/.*')) {

                            req.url = req.url.split('/proxySocket')[1];
                            req.headers.host = '127.0.0.1';

                            _self.log.info('Incoming proxy request for ' + req.url);

                            var haTarget;

                            haTarget = {
                                socketPath: process.env.SOAJS_SWARM_UNIX_PORT || '/var/run/docker.sock'
                            };
                            proxy.web(req, res, {target: haTarget});
                        }
                        else if (parsedUrl.pathname === '/loadProvision') {
                            provision.loadProvision(function (loaded) {
                                var response = maintenanceResponse(req);
                                response['result'] = loaded;
                                return res.end(JSON.stringify(response));
                            });
                        }
                        else {
                            var heartbeat = function (res) {
                                res.writeHead(200, {'Content-Type': 'application/json'});
                                response = maintenanceResponse(req);
                                response['result'] = true;
                                res.end(JSON.stringify(response));
                            };
                            if (req.url === '/heartbeat') {
                                return heartbeat(res);
                            }
                            return heartbeat(res);
                        }
                    });
	
	                app.use(awareness_mw({
		                "awareness": _self.awareness,
		                "serviceName": _self.serviceName,
		                "log": _self.log,
		                "serviceIp": _self.serviceIp
	                }));
	                _self.log.info("Awareness middleware initialization done.");
	
	                //added mw awarenessEnv so that proxy can use req.soajs.awarenessEnv.getHost('dev', cb)
	                app.use(awarenessEnv_mw({
		                "awarenessEnv": true,
		                "log": _self.log
	                }));
	                _self.log.info("AwarenessEnv middleware initialization done.");
	
	                if (_self.soajs.param.bodyParser) {
		                var bodyParser = require('body-parser');
		                var options = (_self.soajs.param.bodyParser.limit) ? {limit: _self.soajs.param.bodyParser.limit} : null;
		                app.use(bodyParser.json(options));
		                app.use(bodyParser.urlencoded({extended: true}));
		                _self.log.info("Body-Parse middleware initialization done.");
	                }
	                else {
		                _self.log.info("Body-Parser middleware initialization skipped.");
	                }
	
	                app.use(controller_mw());
	
	                app.use(enhancer_mw({}));
	
	                var oauthserver = require('oauth2-server');
	                _self.oauth = oauthserver({
		                model: provision.oauthModel,
		                grants: _self.registry.serviceConfig.oauth.grants,
		                debug: _self.registry.serviceConfig.oauth.debug,
		                accessTokenLifetime: _self.registry.serviceConfig.oauth.accessTokenLifetime,
		                refreshTokenLifetime: _self.registry.serviceConfig.oauth.refreshTokenLifetime
	                });
	                _self.soajs.oauthService = _self.soajs.param.oauthService || {
			                "name": "oauth",
			                "tokenApi": "/token",
			                "authorizationApi": "/authorization"
		                };
	                _self.soajs.oauthService.name = _self.soajs.oauthService.name || "oauth";
	                _self.soajs.oauthService.tokenApi = _self.soajs.oauthService.tokenApi || "/token";
	                _self.soajs.oauthService.authorizationApi = _self.soajs.oauthService.authorizationApi || "/authorization";
	                _self.soajs.oauth = _self.oauth.authorise();
	                _self.log.info("oAuth middleware initialization done.");
	
	
	                var mt_mw = require("./../mw/mt/index");
	                app.use(mt_mw({"soajs": _self.soajs, "app": app, "param": _self.soajs.param}));
	                _self.log.info("SOAJS MT middleware initialization done.");
	
	                app.use(function (req, res, next) {
		                setImmediate(function () {
			                req.soajs.controller.gotoservice(req, res, null);
		                });
		
		                req.on("error", function (error) {
			                req.soajs.log.error("Error @ controller:", error);
			                if (req.soajs.controller.redirectedRequest) {
				                req.soajs.controller.redirectedRequest.abort();
			                }
		                });
		
		                req.on("close", function () {
			                if (req.soajs.controller.redirectedRequest) {
				                req.soajs.log.info("Request aborted:", req.url);
				                req.soajs.controller.redirectedRequest.abort();
			                }
		                });
	                });
	
	                app.use(logErrors);
	                app.use(clientErrorHandler);
	                app.use(errorHandler);
	                
                    callback();
                }
                else
                    _self.log.error('Unable to load provision. controller will not start :(');
            });
        });
    }
};

/**
 *
 */
controller.prototype.start = function (cb) {
    var _self = this;
    var maintenancePort = _self.registry.services.controller.port + _self.registry.serviceConfig.ports.maintenanceInc;
    _self.server.on('error', function (err) {
        if (err.code === 'EADDRINUSE') {
            _self.log.error('Address [port: ' + _self.registry.services.controller.port + '] in use by another service, exiting');
        }
        else {
            _self.log.error(err);
        }
    });
    _self.server.listen(_self.registry.services.controller.port, function (err) {
        if (err) {
            _self.log.error(err);
        }
        else {
            _self.log.info(_self.serviceName + " service started on port: " + _self.registry.services.controller.port);
            if (!process.env.SOAJS_DEPLOY_HA) {
                core.registry.registerHost({
                    "serviceName": _self.serviceName,
                    "serviceVersion": _self.serviceVersion,
                    "serviceIp": _self.serviceIp,
                    "serviceHATask": _self.serviceHATask
                }, _self.registry, function (registered) {
                    if (registered)
                        _self.log.info("Host IP [" + _self.serviceIp + "] for service [" + _self.serviceName + "@" + _self.serviceVersion + "] successfully registered.");
                    else
                        _self.log.warn("Unable to register host IP [" + _self.serviceIp + "] for service [" + _self.serviceName + "@" + _self.serviceVersion + "]");
                });
            }
        }
        if (cb) {
            cb(err);
        }
    });
    _self.serverMaintenance.on('error', function (err) {
        if (err.code === 'EADDRINUSE') {
            _self.log.error('Address [port: ' + (maintenancePort) + '] in use by another service, exiting');
        }
        else {
            _self.log.error(err);
        }
    });
    _self.serverMaintenance.listen(maintenancePort, function (err) {
        if (err) {
            _self.log.error(err);
        }
        else {
            _self.log.info(_self.serviceName + " service maintenance is listening on port: " + maintenancePort);
        }
    });
};


controller.prototype.stop = function (cb) {
    var _self = this;
    _self.log.info('stopping controllerServer on port:', _self.registry.services.controller.port);
    _self.server.close(function (err) {
        _self.serverMaintenance.close(function (err) {
            if (cb) {
                cb(err);
            }
        });
    });
};

//-------------------------- ERROR Handling MW
/**
 *
 * @param err
 * @param req
 * @param res
 * @param next
 */
function logErrors(err, req, res, next) {
    if (typeof err === "number") {
        req.soajs.log.error(core.error.generate(err));
        return next(err);
    }
    if (typeof err === "object") {
        if (err.code && err.message) {
            req.soajs.log.error(err);
            return next({"code": err.code, "msg": err.message});
        }
        else {
            req.soajs.log.error(err);
            req.soajs.log.error(core.error.generate(164));
        }
    }
    else {
        req.soajs.log.error(err);
        req.soajs.log.error(core.error.generate(164));
    }

    return next(core.error.getError(164));
}
/**
 *
 * @param err
 * @param req
 * @param res
 * @param next
 */
function clientErrorHandler(err, req, res, next) {
    if (req.xhr) {
        req.soajs.log.error(core.error.generate(150));
        var errObj = core.error.getError(150);
        errObj.status = 500;
        req.soajs.controllerResponse(errObj);
    } else {
        return next(err);
    }
}
/**
 *
 * @param err
 * @param req
 * @param res
 * @param next
 */
function errorHandler(err, req, res, next) {
    if (err.code && err.msg) {
        err.status = 500;
        req.soajs.controllerResponse(err);
    } else {
        var errObj = core.error.getError(err);
        errObj.status = 500;
        req.soajs.controllerResponse(errObj);
    }
}

module.exports = controller;
