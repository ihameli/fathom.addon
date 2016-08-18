/*
   Fathom - Browser-based Network Measurement Platform

   Copyright (C) 2011-2016 Inria Paris-Roquencourt 
                           International Computer Science Institute (ICSI)

   See LICENSE for license and terms of usage. 
*/

/**
 * @fileoverfiew JSONRPC protocol implementation using fathom socket
 *               and SDK http APIs.
 * 
 * @author Anna-Kaisa Pietilainen <anna-kaisa.pietilainen@inria.fr> 
 */
const timers = require("sdk/timers");
const Request = require("sdk/request").Request;

const _ = require('underscore');

const {error, FathomException} = require("../error");
const socketapi = require("../socketapi");

/* Standard JSON-RPC stuff, from
 * http://www.jsonrpc.org/specification
 */
const JSONRPC_V = "2.0";
const JSONRPC_E = {
    'parse' :        {code : -32700, message : "Parse error"},
    'invalidreq' :   {code : -32600, message : "Invalid Request"},
    'notfound' :     {code : -32601, message : "Method not found"},
    'invalidparam' : {code : -32602, message : "Invalid params"},
    'internal' :     {code : -32603, message : "Internal error"},
    'servererror' :  {code : -32000, message : "Server error"}
};

// Will contain the SID and a dictionary with request id to callbacks
var sendingSocket = null;
var jsonrpcInstanceCounter = 0;

/** JSONRPC request. */
var JsonReq = function(id, method, params) {
    this.jsonrpc = JSONRPC_V;
    this.id = id;
    this.method = method;
    this.params = params;
};

/** JSONRPC response. */
var JsonResp = function(id, result, err) {
    this.jsonrpc = JSONRPC_V;
    this.id = id;
    if (err) {
  if (!JSONRPC_E[err])
      err = 'serverrror';
  this.error = JSONRPC_E[err];
    } else {
  this.result = result;
    }
};

/** JSONRPC protocol object constructor. */
var rpc = exports.JSONRPC = function(manifest, ip, port, server, proto, path) {
  this.manifest = manifest;

  this.ip = ip;
  this.port = port;
  this.isserver = server || false;
  this.proto = proto || 'udp'; 
  this.path = path || '/';        // basepath (HTTP only)
  
  this.socketid = -1;             // fathom socket id
  this.reqid = 0;                 // running socket req id
  this.rpcreqid = 0;
  jsonrpcInstanceCounter += 1;
  this.objectId = jsonrpcInstanceCounter;
};

rpc.prototype.getSendingSocket = function(callback, proto, args) {
  proto = proto || 'udpOpen';
  args = args || [];
  var that = this;
  if (sendingSocket === null) {
    console.log('jsonrpc', 'getSocket create new socket')
    that.makesocketreq(function(sid) {
      if (sid.error) {
        return callback(sid,true);
      }
      sendingSocket = {};
      sendingSocket.sid = sid;
      sendingSocket.callbacks = {};
      if (!that.isserver && that.socketid === -1)
        that.socketid = sendingSocket.sid;

      that.makesocketreq(function(res, done) {
        if (res.error) {
          callback(res,done);
        } else if (res.data) {
          try {
            var resobj = JSON.parse(res.data);
            if (resobj.error) {
              callback(error("jsonrpc",resobj.error.message),done);
            } else {
              var retrievedCallback;
              if (retrievedCallback = sendingSocket.callbacks[resobj.id]) {
                var result = {result: resobj.result, address: res.address};
                retrievedCallback(result, done);
              } else {
                console.error("jsonrpc", "Got response but there was no request, response ",resobj);
              }
            }
          } catch (e) {
            console.error("invalid jsonrpc",e);
            callback(error("parseerror",e), done);
          }
        }
      },'udpRecvFromStart',[sid,true],true);
      callback(sendingSocket.sid);
    },proto, args);
  } else {
    console.log('jsonrpc', 'getSocket recycle socket');
    if (!that.isserver && that.socketid === -1)
      that.socketid = sendingSocket.sid;
    callback(sendingSocket.sid);
  }
};

rpc.prototype.makeReqAndRecycle = function(callback, msgobj, timeout) {
  var that = this;
  var msg = JSON.stringify(msgobj);
  that.getSendingSocket(function(sid) {

    sendingSocket.callbacks[msgobj.id] = callback;
    // console.log("sendingSocket.callbacks",sendingSocket.callbacks);

    that.makesocketreq(function(res, done) {
      if (res.error) {
        // that.makesocketreq(function() {},'close',[sid]);    
        return callback(res,true);
      }
      // set timer for close
      timers.setTimeout(function() {
        callback({timeout:true}, true);
        delete sendingSocket.callbacks[msgobj.id];
      }, timeout*1000);
    },'udpSendTo',[sid,msg,that.ip,that.port]);
  });
};

/** Socket req helper. */
rpc.prototype.makesocketreq = function(callback, method, params, multi) {
    this.reqid += 1;
    socketapi.exec(callback,
       { module : "socket",
         submodule : this.proto,
         id : this.objectId+"-reqid-"+this.reqid,
         method : method,
         params : params || [],
         multiresp : multi || false
       },
       this.manifest);
};
      
/** Connect socket. */
rpc.prototype.connect = function(callback) {
  var that = this;
  if (!this.port)
    return callback(error("missingparams","port"));

  if (this.isserver) {
    if (this.proto !== 'udp' && this.proto !== 'multicast')
      return callback(error("invalidparams","proto="+this.proto));

    that.makesocketreq(function(sid) {
      if (sid.error) {
        return callback(sid, true);
      }

      that.socketid = sid;
      var ready = function(res) {
        if (res.error) {
            that.makesocketreq(function() {},
                   'close',[that.socketid]);
            that.socketid = -1;
            that.reqid = 0;
        }   
        callback(res, true);
      };

      if (that.proto === 'udp') {
        that.makesocketreq(ready,"udpBind",
          [that.socketid,0,that.port,true]);
      } else {
        that.makesocketreq(ready,"multicastJoin", 
          [that.socketid,that.ip,that.port,true]);
      }
    },(this.proto === 'udp' ? 'udpOpen' : 'multicastOpenSocket'),[]);
  } else {
    // cli opens a socket / request
    callback({},true);
  }
};

/** Start listening for incoming requests (server mode). */
rpc.prototype.listen = function(callback) {
  if (!this.isserver) 
    return callback(error("execerror","not a server"));

  // handle incoming RPC request
  var that = this;
  var ondata = function(res) {
    if (res.error) {
      console.error("error receiving jsonrpc req:" + res.error);

    } else if (res.data && res.data.length > 0) {
      var req = undefined;
      try {
        req = JSON.parse(res.data);
      } catch (e) {
        console.error("received malformed jsonrpc req:" + res.data);
      }

      if (req) {
        req.rinfo = { address : res.address, port : res.port };
        try {
          // handle API call
          callback(req,false);
        } catch (e) {
          console.error("API callback problem:",e);
          that.sendres(function(){}, req, "internal");
        }
      } else {
        // parsing error
        req = {rinfo : { address : res.address, port : res.port }};
        that.sendres(function(){}, req, "parse");
      }
    }
  };

  this.makesocketreq(ondata,
   "udpRecvFromStart",
   [this.socketid,true],
             true); // multiresp
};

/** Send response to a received request (server mode). */
rpc.prototype.sendres = function(callback, res, err) {
  if (!this.isserver)
    return callback(error("execerror","not a server"));
  if (!res.rinfo)
    return callback(error("missingparams","rinfo"));
  if (!res.id)
    return callback(error("missingparams","id"));
  if (!res.result && !err)
    return callback(error("missingparams","result and error"));

  var msgobj = new JsonResp(res.id,res.result,err);
  var msg = JSON.stringify(msgobj);

  var that = this;

  that.getSendingSocket(function(sid) {
    that.makesocketreq(function(res, done) {
      callback(res,true); 
    },'udpSendTo',[sid,msg,res.rinfo.address,res.rinfo.port]);
  });
}; // sendres

/** Make RPC req (client mode). */
rpc.prototype.makereq = function(callback, method, params, module, urlparams, timeout) {
  if (this.isserver)
    return callback(error("execerror","not a client"));
  if (timeout === undefined) {
    timeout = 10;
  }

  this.rpcreqid += 1;
  var msgobj = new JsonReq(this.objectId+"-rpcreqid-"+this.rpcreqid, method, params);
  var msg = JSON.stringify(msgobj);

  var that = this;
  switch (this.proto) {
    case "http":
      var url = "http://" + 
          that.ip+(that.port && that.port !== 80 ? ":"+that.port : "") +
          that.path + 
          (module ? (that.path !== '/' ? "/" : "")+module : "");

      if (urlparams)
          url += '?' + _.map(urlparams, function(v,k) {
        return k+'='+v;
          }).join('&');
      
      Request({
          url: url,
          content: msg,
          onComplete: function(response) {
        if (response.status == 200 && response.json && 
            !response.json.error) {
            callback(response.json.result,true);
        } else {
            let err = undefined;
            if (response.json && response.json.error)
          err = error("jsonrpc",response.json.error.message);
            else
          err = error("http",
                response.status+"/"+response.statusText);
            callback(err,true);
        }
          }
      }).post();  

      break;

    case "udp":
    case "multicast":
      this.makeReqAndRecycle(callback, msgobj, timeout);
      break;

    case "tcp": 
      callback({error : "not implemented: " + this.proto});
      break;
  
    default:
      callback({error : "invalid client protocol: " + this.proto});
  }
};

/** Cleanup */
rpc.prototype.close = function(callback) {
  if (this.socketid && this.socketid >= 0 && this.isserver) {
    this.makesocketreq(function() {},'udpRecvStop',[this.socketid]);
    this.makesocketreq(function() {},'close',[this.socketid]);
  }
  this.socketid = -1;
  this.reqid = 0;
  this.rpcreqid = 0;    
  callback({},true);
};