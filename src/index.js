
export class SubscriptionManager {
	/**
	 * @param {function} fetcher a function that fetches the authorized subscriptiom token from your backend
	 * @param {string} env the environment to use. "dev" for development or "prod" for production
	*/
	constructor(fetcher = () => { throw new Error("Missing fetcher function") }, { env, subscribeUrl } = { env: "dev" }) {
		this.fetcher = fetcher;
		if (!subscribeUrl) {
			this.subscribeUrl = `https://${env}.exoquic.com/subscribe`
		} else {
			this.subscribeUrl = subscribeUrl
		}
	}

	async authorizeSubscriber(subscriptionData = null) {
		const authorizationToken = await this.fetcher(subscriptionData);

		if (!authorizationToken) {
			throw new Error("Cannot authorize subscriber because fetcher function returned null");
		}

		if (typeof authorizationToken !== 'string') {
			throw new Error(`Cannot authorize subscriber because fetcher function returned a non-string value: ${authorizationToken}`);
		}

		return new AuthorizedSubscriber(authorizationToken, { ...DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS, serverUrl: this.subscribeUrl });
	}
}

export const DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS = {
	shouldReconnect: true,
	reconnectTimeout: 1000,
	maxReconnectTimeout: 10000,
	serverUrl: 'wss://dev.exoquic.com/subscribe',
};

export class AuthorizedSubscriber {
	constructor(
		authorizationToken, 
		{ 
			serverUrl = DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS.serverUrl, 
			shouldReconnect = DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS.shouldReconnect, 
			reconnectTimeout = DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS.reconnectTimeout, 
			maxReconnectTimeout = DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS.maxReconnectTimeout 
		}
	) {
		this.authorizationToken = authorizationToken;
		this.serverUrl = serverUrl;
		this.shouldReconnect = shouldReconnect;
		this.reconnectTimeout = reconnectTimeout;
		this.maxReconnectTimeout = maxReconnectTimeout;

		this.isSubscribed = false;
		this.isConnected = false;
	}

	/**
	 * @param {function} onMessageCallback a function that is called when a new event batch is received
	 * @returns {AuthorizedSubscriber} the authorized subscriber
	*/
	subscribe(onEventBatchReceivedCallback) {
		if (this.isSubscribed) {
			return;
		}

		this.isSubscribed = true;

		this.ws = new WebSocket(`${this.serverUrl}`, [this.authorizationToken]);

		this.ws.onmessage = eventBatch => {
			onEventBatchReceivedCallback(eventBatch);
		};

		this.ws.onopen = () => {
			this.isConnected = true;
		};

		this.ws.onclose = (event) => {
			this.isConnected = false;

			const isCleanClose = event.code === 1000;

			if (this.shouldReconnect && !isCleanClose) {
				setTimeout(() => {
					this.reconnectTimeout = Math.min(this.reconnectTimeout * 1.5, this.maxReconnectTimeout);
					this.subscribe(onEventBatchReceivedCallback);
				}, this.reconnectTimeout);
			}
		};

		this.ws.onerror = (error) => {
			console.error('Exoquic subscription error:', error);
		};

		return this;
	}

	unsubscribe() {
		this.isSubscribed = false;
		this.ws.close(1000, "unsubscribe");
	}

}
