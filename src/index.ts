interface Env {
	CORS_ALLOW_ORIGIN: string;
	HELIUS_API_KEY: string;
}

export default {
	async fetch(request: Request, env: Env) {

		// If the request is an OPTIONS request, return a 200 response with permissive CORS headers
		// This is required for the Helius RPC Proxy to work from the browser and arbitrary origins
		// If you wish to restrict the origins that can access your Helius RPC Proxy, you can do so by
		// changing the `*` in the `Access-Control-Allow-Origin` header to a specific origin.
		// For example, if you wanted to allow requests from `https://example.com`, you would change the
		// header to `https://example.com`. Multiple domains are supported by verifying that the request
		// originated from one of the domains in the `CORS_ALLOW_ORIGIN` environment variable.
		const supportedDomains = env.CORS_ALLOW_ORIGIN ? env.CORS_ALLOW_ORIGIN.split(',') : undefined;
		const corsHeaders: Record<string, string> = {
			"Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
			"Access-Control-Allow-Headers": "*",
		}
		if (supportedDomains) {
			const origin = request.headers.get('Origin')
			if (origin && supportedDomains.includes(origin)) {
				corsHeaders['Access-Control-Allow-Origin'] = origin
			}
		} else {
			corsHeaders['Access-Control-Allow-Origin'] = '*'
		}

		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 200,
				headers: corsHeaders,
			});
		}

	const upgrade = request.headers.get('Upgrade')?.toLowerCase();
	if (upgrade === 'websocket') {
		const { search } = new URL(request.url);
		const upstreamUrl = `wss://mainnet.helius-rpc.com${search ? `${search}&` : '?'}api-key=${env.HELIUS_API_KEY}`;
		
		// Extract subprotocol from client request
		const clientProtocols = request.headers.get('Sec-WebSocket-Protocol');
		const selectedProtocol = clientProtocols ? clientProtocols.split(',')[0].trim() : undefined;
		
		// Create WebSocket pair
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);
		
		// Accept the client connection
		server.accept();
		
		// Connect to upstream WebSocket with subprotocol if present
		const upstream = selectedProtocol 
			? new WebSocket(upstreamUrl, [selectedProtocol])
			: new WebSocket(upstreamUrl);
		
		// Keepalive timer - send heartbeat every 20 seconds to upstream only
		let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
		
		const startKeepalive = () => {
			keepaliveTimer = setInterval(() => {
				if (upstream.readyState === WebSocket.OPEN) {
					try {
						upstream.send(JSON.stringify({
							"jsonrpc": "2.0",
							"method": "helius_keepalive"
						}));
					} catch (error) {
						// If keepalive fails, connection is likely broken
						clearKeepalive();
					}
				} else {
					clearKeepalive();
				}
			}, 20000);
		};
		
		const clearKeepalive = () => {
			if (keepaliveTimer) {
				clearInterval(keepaliveTimer);
				keepaliveTimer = null;
			}
		};
		
		// Start keepalive once upstream connection is open
		upstream.addEventListener('open', () => {
			startKeepalive();
		});
		
		// Forward messages from client to upstream
		server.addEventListener('message', event => {
			if (upstream.readyState === WebSocket.OPEN) {
				try {
					upstream.send(event.data);
				} catch (error) {
					// Error sending to upstream, close client with error code
					clearKeepalive();
					try {
						server.close(1011, "upstream_ws_error");
					} catch {}
				}
			}
		});
		
		// Forward messages from upstream to client
		upstream.addEventListener('message', event => {
			if (server.readyState === WebSocket.OPEN) {
				try {
					server.send(event.data);
				} catch (error) {
					// Error sending to client, close upstream with error code
					clearKeepalive();
					try {
						upstream.close(1011, "client_ws_error");
					} catch {}
				}
			}
		});
		
		// Handle connection close - propagate close codes and reasons
		server.addEventListener('close', (event) => {
			clearKeepalive();
			try {
				const closeCode = event.code || 1000;
				const closeReason = event.reason || "client_closed";
				upstream.close(closeCode, closeReason);
			} catch {}
		});
		
		upstream.addEventListener('close', (event) => {
			clearKeepalive();
			try {
				const closeCode = event.code || 1011;
				const closeReason = event.reason || "upstream_closed";
				server.close(closeCode, closeReason);
			} catch {}
		});
		
		// Handle errors - close opposite side with error code 1011
		server.addEventListener('error', () => {
			clearKeepalive();
			try {
				upstream.close(1011, "client_ws_error");
			} catch {}
		});
		
		upstream.addEventListener('error', () => {
			clearKeepalive();
			try {
				server.close(1011, "upstream_ws_error");
			} catch {}
		});
		
		// Prepare response headers with subprotocol if negotiated
		const responseHeaders: Record<string, string> = {};
		if (selectedProtocol) {
			responseHeaders['Sec-WebSocket-Protocol'] = selectedProtocol;
		}
		
		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: responseHeaders,
		});
	}


		const { pathname, search } = new URL(request.url)
		const payload = await request.text();
		const proxyRequest = new Request(`https://${pathname === '/' ? 'mainnet.helius-rpc.com' : 'api.helius.xyz'}${pathname}?api-key=${env.HELIUS_API_KEY}${search ? `&${search.slice(1)}` : ''}`, {
			method: request.method,
			body: payload || null,
			headers: {
				'Content-Type': 'application/json',
				'X-Helius-Cloudflare-Proxy': 'true',
			}
		});

		return await fetch(proxyRequest).then(res => {
			return new Response(res.body, {
				status: res.status,
				headers: corsHeaders
			});
		});
	},
};
