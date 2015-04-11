/* This is an NDT client, written in javascript.  It speaks the websocket
 * version of the NDT protocol.  The NDT protocol is documented at:
 * https://code.google.com/p/ndt/wiki/NDTProtocol
 */

/*jslint bitwise: true, node: true */
/*global Uint8Array */

'use strict';

function NDTjs(server, port, path, callbacks) {

	var _this = this;

	this.server = server;
	this.server_port = port;
	this.server_path = path;
	this.c2s_rate;
	this.s2c_rate;
	this.err_msg;

	// A list of web100 variable values that we want to capture from the server
	// output.  The name of the variable below must be identical to the
	// variable as defined here:
	// https://code.google.com/p/ndt/wiki/NDTProtocol#Appendix_A._web100_variables
	this.web100vars = {
		'MinRTT': null
	}

	// Someone may want to run this test without callbacks (perhaps for
	// debugging). Since the callbacks are referenced in various places, just
	// create some empty ones if none were specified.
	if ( typeof callbacks === 'undefined' ) {
		this.callbacks = {
			'onstart': function(){},
			'onchange': function(){},
			'onfinish': function(){},
			'onerror': function(){}
		};
	} else {
		this.callbacks = callbacks;
	}

	// Constants in use by the entire program, and a live connection to the
	// server.  The order of these is important because their equivalent
	// numeric representations correspond to the index number in the array.
	this.msg_names = [
		"COMM_FAILURE",
		"SRV_QUEUE",
		"MSG_LOGIN",
		"TEST_PREPARE",
		"TEST_START",
		"TEST_MSG",
		"TEST_FINALIZE",
		"MSG_ERROR",
		"MSG_RESULTS",
		"MSG_LOGOUT",
		"MSG_WAITING",
		"MSG_EXTENDED_LOGIN"
	];
	
	// Makes a login message suitable for sending to the server.  The login
	// messages specifies the tests to be run.
	this.make_login_msg = function(desired_tests) {
		// We must support TEST_STATUS (16) as a 3.5.5+ client, so we make sure test 16 is desired.
		var i = 0,
			msg = 'XXX { "msg": "v3.5.5", "tests": "' + (desired_tests | 16) + '" }',
		data = new Uint8Array(msg.length);
		data[0] = _this.msg_names.indexOf('MSG_EXTENDED_LOGIN');
		data[1] = 0;  // Two bytes to represent packet length
		data[2] = msg.length - 3;
		for (i = 3; i < msg.length; i += 1) {
			data[i] = msg.charCodeAt(i);
		}
		return data;
	}

	// A generic message creation system.  The output is an array of bytes
	// suitable for sending on a binary websocket.
	this.make_ndt_msg = function(type, msg) {
		var message_body, data, i;
		message_body = '{ "msg": "' + msg + '" } ';
		data = new Uint8Array(message_body.length + 3);
		data[0] = type;
		data[1] = (message_body.length >> 8) & 0xFF;
		data[2] = message_body.length & 0xFF;
		for (i = 0; i < message_body.length; i++) {
			data[i + 3] = message_body.charCodeAt(i);
		}
		return data;
	}
	

	this.parse_ndt_msg = function(buf) {
	
		var resp = [];
		var array = new Uint8Array(buf);
		for ( var i = 0; i < 3; i++ ) {
			resp[i] = array[i];
		}
		var msg =  String.fromCharCode.apply(null, new Uint8Array(buf.slice(3)));
		resp.push(msg);
		return resp;
	
	}


	// Returns a closure that will process all messages for the META NDT test.
	// The closure will return the boolean true when the test is complete and
	// the closure should no longer be called.
	this.ndt_meta_test = function(sock) {
		var state = "WAIT_FOR_TEST_PREPARE";
		return function (type, body) {
			if (state === "WAIT_FOR_TEST_PREPARE" && type === _this.msg_names.indexOf('TEST_PREPARE')) {
				_this.callbacks['onchange']('preparing_meta');
				state = "WAIT_FOR_TEST_START";
				return false;
			}
			if (state === "WAIT_FOR_TEST_START" && type === _this.msg_names.indexOf('TEST_START')) {
				_this.callbacks['onchange']('running_meta');
				// Send one piece of meta data and then an empty meta data packet
				sock.send(_this.make_ndt_msg(_this.msg_names.indexOf('TEST_MSG'), "client.os.name:CLIWebsockets"));
				sock.send(_this.make_ndt_msg(_this.msg_names.indexOf('TEST_MSG'), ""));
				state = "WAIT_FOR_TEST_FINALIZE";
				return false;
			}
			if (state === "WAIT_FOR_TEST_FINALIZE" && type === _this.msg_names.indexOf('TEST_FINALIZE')) {
				_this.callbacks['onchange']('finished_meta');
				_this.log_msg("ndt_meta_test is done");
				return true;
			}
 			error_message = "Bad state and message combo for META test: " + state + ", " + type + ", " + body.msg;
            throw _this.TestFailureException(error_message);
		};
	}
	

	// Returns a closure that will process all messages for the S2C NDT test.
	// The closure will return the boolean true when the test is complete and
	// the closure should no longer be called.
	this.ndt_s2c_test = function(sock) {
		var state = "WAIT_FOR_TEST_PREPARE",
			server_port,
			test_connection,
			received_bytes = 0,
			test_start,
			test_end;
	
		// The closure that processes messages on the control socket for the s2c test.
		return function (type, body) {
			var throughput;

			_this.log_msg("CALLED S2C with " + type + " (" + _this.msg_names[type] + ") in state " + state);

			if (state === "WAIT_FOR_TEST_PREPARE" && type === _this.msg_names.indexOf('TEST_PREPARE')) {
				_this.callbacks['onchange']('preparing_s2c');

				server_port = Number(body.msg);
				test_connection = new WebSocket("ws://" + _this.server + ":" + server_port + _this.server_path, 's2c');
				test_connection.binaryType = 'arraybuffer';

				test_connection.onopen = function() {
					_this.log_msg("OPENED S2C SUCCESFULLY!");
					test_start = Date.now() / 1000;
				}

				test_connection.onmessage = function(e) {
					var message = _this.parse_ndt_msg(e.data);
					var hdr_size;
					if (message[3].length < 126) {
						hdr_size = 2;
					} else if (message[3].length < 65536) {
						hdr_size = 4;
					} else {
						hdr_size = 10;
					}
					received_bytes += (hdr_size + message[3].length);
				}

				test_connection.onerror = function(e) {
                    error_message = _this.parse_ndt_msg(e.data)[3].msg;
                    throw _this.TestFailureException(error_message);
				}

				state = "WAIT_FOR_TEST_START";
				return false;
			}
			if (state === "WAIT_FOR_TEST_START" && type === _this.msg_names.indexOf('TEST_START')) {
				_this.callbacks['onchange']('running_s2c');
				state = "WAIT_FOR_FIRST_TEST_MSG";
				return false;
			}
			if (state === "WAIT_FOR_FIRST_TEST_MSG" && type === _this.msg_names.indexOf('TEST_MSG')) {
				_this.log_msg('Got message: ' + JSON.stringify(body));
				state = "WAIT_FOR_TEST_MSG_OR_TEST_FINISH";
				if (test_end === undefined) {
					test_end = Date.now() / 1000;
				}
				// Calculation per NDT spec
				_this.s2c_rate = 8 * received_bytes / 1000 / (test_end - test_start);
				_this.log_msg("S2C rate calculated by client: " + _this.s2c_rate);
				_this.log_msg("S2C rate calculated by server: " + body.ThroughputValue);
				sock.send(_this.make_ndt_msg(_this.msg_names.indexOf('TEST_MSG'), String(_this.s2c_rate)));
				return false;
			}
			if (state === "WAIT_FOR_TEST_MSG_OR_TEST_FINISH" && type === _this.msg_names.indexOf('TEST_MSG')) {
				_this.log_msg("Got results: " +  body.msg);
				for ( var web100var in _this.web100vars ) {
					var re = new RegExp('^' + web100var + ':\\s+(.*)');
					if ( body.msg.match(re) ) {
						_this.web100vars[web100var] = body.msg.match(re)[1];
						_this.log_msg('Set ' + web100var + ' to ' + _this.web100vars[web100var]);
					}
				}
				return false;
			}
			if (state === "WAIT_FOR_TEST_MSG_OR_TEST_FINISH" && type === _this.msg_names.indexOf('TEST_FINALIZE')) {
				_this.callbacks['onchange']('fnished_s2c');
				_this.log_msg("Test is over! " +  body.msg);
				return true;
			}
			_this.log_msg("S2C: State = " + state + " type = " + type + "(" + msg_names[type] + ") message = ", body);
		};
	}
	
	
	this.ndt_c2s_test = function() {
		var state = "WAIT_FOR_TEST_PREPARE",
			server_port,
			test_connection,
			data_to_send = new Uint8Array(1048576),
			test_start,
			test_end
	
		for (var i = 0; i < data_to_send.length; i += 1) {
			// All the characters must be printable, and the printable range of
			// ASCII is from 32 to 126.  101 is because we need a prime number.
			data_to_send[i] = 32 + (i * 101) % (126 - 32);
		}
	
		// A while loop, encoded as a setTimeout callback.
		function keep_sending_data() {
			// Refill the buffer if it gets too low
			if ( test_connection.bufferedAmount < 8192 ) {
				test_connection.send(data_to_send);
			}
			if (Date.now() / 1000 < test_start + 10) {
				setTimeout(keep_sending_data, 0);
			} else {
				test_end = Date.now() / 1000;
			}
		}
	
		return function (type, body) {
			_this.log_msg("CALLED C2S with " + type + " (" + _this.msg_names[type] + ") " + body.msg + " in state " + state);
			if (state === "WAIT_FOR_TEST_PREPARE" && type === _this.msg_names.indexOf('TEST_PREPARE')) {
				_this.callbacks['onchange']('preparing_c2s');
				server_port = Number(body.msg);
				test_connection = new WebSocket("ws://" + _this.server + ":" + server_port + _this.server_path, 'c2s');
				test_connection.binaryType = 'arraybuffer';
				state = "WAIT_FOR_TEST_START";
				return false;
			}
			if (state === "WAIT_FOR_TEST_START" && type === _this.msg_names.indexOf('TEST_START')) {
				_this.callbacks['onchange']('running_c2s');
				test_start = Date.now() / 1000;
				keep_sending_data();
				state = "WAIT_FOR_TEST_MSG";
				return false;
			}
			if (state === "WAIT_FOR_TEST_MSG" && type === _this.msg_names.indexOf('TEST_MSG')) {
				_this.c2s_rate = body.msg;
				_this.log_msg("C2S rate calculated by server: " + _this.c2s_rate);
				state = "WAIT_FOR_TEST_FINALIZE";
				return false;
			}
			if (state === "WAIT_FOR_TEST_FINALIZE" && type === _this.msg_names.indexOf('TEST_FINALIZE')) {
				_this.callbacks['onchange']('finished_c2s');
				state = "DONE";
				return true;
			}
			_this.log_msg("C2S: State = " + state + " type = " + type + "(" + msg_name[type] + ") message = ", body);
		};
	}
	
	
	this.ndt_coordinator = function() {

		var sock,
			state = "",
			active_test,
			tests_to_run = [];
	
		_this.log_msg('Test started.  Waiting for connection to server...');
		_this.callbacks['onstart'](_this.server);

		sock = new WebSocket("ws://" + _this.server + ":" + _this.server_port + _this.server_path, 'ndt');
		sock.binaryType = 'arraybuffer';
	
		sock.onopen = function() {
			_this.log_msg("OPENED CONNECTION on port " + _this.server_port);
			// Sign up for every test except for TEST_MID and TEST_SFW - browsers can't
			// open server sockets, which makes those tests impossible, because they
			// require the server to open a connection to a port on the client.
			sock.send(_this.make_login_msg(2 | 4 | 32));
			state = "LOGIN_SENT";
		}
	
		sock.onmessage = function(e) {
	
			var message = _this.parse_ndt_msg(e.data),
				type = message[0],
				body = JSON.parse(message[3]),
				tests;

			_this.log_msg("type = " + type + " (" + _this.msg_names[type] + ") body = '" + body.msg + "'");
			if (active_test === undefined && tests_to_run.length > 0) {
				active_test = tests_to_run.pop();
			}
			if (active_test !== undefined) {
				// Pass the message to the sub-test
				_this.log_msg("Calling a subtest");
				if (active_test(type, body) === true) {
					active_test = undefined;
					_this.log_msg("Subtest complete");
				}
				return;
			}
			// If there is an active test, hand off control to the test
			// Otherwise, move the coordinator state forwards.
			if (state === "LOGIN_SENT") {
				// Response to NDT_LOGIN should be SRV_QUEUE messages until we get SRV_QUEUE("0")
				if (type === _this.msg_names.indexOf('SRV_QUEUE')) {
					if (body.msg === "9990") {	  // special keepalive message
						sock.send(_this.make_ndt_msg(_this.msg_names.indexOf('MSG_WAITING'), ""));
					} else if (body.msg === "9977") {	 // Test failed
						throw _this.TestFailureException("Server terminated test with SRV_QUEUE 9977");
					}
					_this.log_msg("Got SRV_QUEUE. Ignoring and waiting for MSG_LOGIN");
				} else if (type === _this.msg_names.indexOf('MSG_LOGIN')) {
					if (body.msg[0] !== "v") { _this.log_msg("Bad msg " + body.msg); }
					state = "WAIT_FOR_TEST_IDS";
				} else {
 					error_message = "Expected type 1 (SRV_QUEUE) or 2 (MSG_LOGIN) but got " + type + " (" + _this.msg_names[type] + ")";
                    throw _this.TestFailureException(error_message);
				}
			} else if (state === "WAIT_FOR_TEST_IDS" && type === _this.msg_names.indexOf('MSG_LOGIN')) {
				tests = body.msg.split(" ");
				for (var i = tests.length - 1; i >= 0; i -= 1) {
					if (tests[i] === "2") {
						tests_to_run.push(_this.ndt_c2s_test());
					} else if (tests[i] === "4") {
						tests_to_run.push(_this.ndt_s2c_test(sock));
					} else if (tests[i] === "32") {
						tests_to_run.push(_this.ndt_meta_test(sock));
					} else if (tests[i] !== '') {
                        error_message = "Unknown test type: " + tests[i];
                        throw _this.TestFailureException(error_message);
					}
				}
				state = "WAIT_FOR_MSG_RESULTS";
			} else if (state === "WAIT_FOR_MSG_RESULTS" && type === _this.msg_names.indexOf('MSG_RESULTS')) {
				_this.log_msg(body);
			} else if (state === "WAIT_FOR_MSG_RESULTS" && type === _this.msg_names.indexOf('MSG_LOGOUT')) {
				sock.close();
				_this.callbacks['onchange']('finished_all');
				_this.callbacks['onfinish']();
				_this.log_msg("TESTS FINISHED SUCCESSFULLY!");
			} else {
                error_message = "Didn't know what to do with message type " + type + " in state " + state;
                throw _this.TestFailureException(error_message);
			}
		}
	
		sock.onerror = function(e) {
 			error_message = _this.parse_ndt_msg(e.data)[3].msg;
            throw _this.TestFailureException(error_message);
		};
	
	}
	
	
	this.log_msg= function(msg) {
	
		var debugDiv = document.getElementById('debug');
		debugDiv.innerHTML += '<br/>&raquo; ' + msg;
		console.log(msg);
	
	}
    this.ConnectionException = function(message) {
        NDTjs.log_msg(message)
        _this.callbacks['onerror'](message);
     }
     this.TestFailureException = function(message) {
        NDTjs.log_msg(message)
        _this.callbacks['onerror'](message);
     }
}
