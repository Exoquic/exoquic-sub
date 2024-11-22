

export class SubscriptionManager {
	/**
	 * @param {string} authorizeSubscriptionUrl the url to your backend that authorizes the subscription
	 * @param {string} subscribeUrl the url to the Exoquic subscribe server. Prefix with dev. for development or prod. for production
	*/
	constructor(authorizeSubscriptionUrl, subscribeUrl = 'wss://dev.exoquic.com/subscribe') {
		this.authorizeSubscriptionUrl = authorizeSubscriptionUrl;
		this.subscribeUrl = subscribeUrl;
	}

	async authorizeSubscription(subscriptionData, headers = {}) {
		const response = await fetch(this.authorizeSubscriptionUrl, {
			method: 'POST',
			body: JSON.stringify(subscriptionData),
			headers,
		});

		if (!response.ok) {
			throw new Error(`Failed to authorize subscription: ${response.statusText}`);
		}

		const contentType = response.headers.get('content-type');
		let authorizedSubscription;

		if (contentType.includes('application/json')) {
			const authorizedSubscriptionWrapper = await response.json();
			authorizedSubscription = authorizedSubscriptionWrapper.token;
		} else if (contentType.includes('text/plain')) {
			authorizedSubscription = await response.text();
		} else {
			throw new Error('Invalid content type. Must be application/json or text/plain');
		}

		return new AuthorizedSubscription(authorizedSubscription, { ...DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS, serverUrl: this.subscribeUrl });
	}
}

export const DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS = {
	shouldReconnect: true,
	reconnectTimeout: 1000,
	maxReconnectTimeout: 10000,
	serverUrl: 'wss://dev.exoquic.com/subscribe',
};

export class AuthorizedSubscription {
	constructor(
		authorizedSubscription, 
		{ 
			serverUrl = DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS.serverUrl, 
			shouldReconnect = DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS.shouldReconnect, 
			reconnectTimeout = DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS.reconnectTimeout, 
			maxReconnectTimeout = DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS.maxReconnectTimeout 
		}
	) {
		this.authorizedSubscription = authorizedSubscription;
		this.serverUrl = serverUrl;
		this.shouldReconnect = shouldReconnect;
		this.reconnectTimeout = reconnectTimeout;
		this.maxReconnectTimeout = maxReconnectTimeout;

		this.isSubscribed = false;
		this.isConnected = false;
	}

	subscribe(onMessageCallback) {
		if (this.isSubscribed) {
			return;
		}

		this.isSubscribed = true;

		this.ws = new WebSocket(`${this.serverUrl}`, [this.authorizedSubscription]);

		this.ws.onmessage = event => {
				onMessageCallback(event);
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
					this.subscribe(onMessageCallback);
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
		this.ws.close();
	}

}
