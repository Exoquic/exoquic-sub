import { deleteDB, openDB } from "idb";
import { jwtDecode } from "jwt-decode";

export class SubscriptionManager {
	/**
	 * @param {function} fetcher a function that fetches the authorized subscriptiom token from your backend
	 * @param {string} env the environment to use. "dev" for development or "prod" for production
	 * @param {string} name the name of the subscription manager. An IndexedDB database will be created with this name.
	*/
	constructor(fetcher = () => { throw new Error("Missing fetcher function") }, { env = "dev", subscribeUrl, name = "default", cacheEnabled = true }) {
		this.fetcher = fetcher;
		if (!subscribeUrl) {
			this.subscribeUrl = `https://${env}.exoquic.com/subscribe`
		} else {
			this.subscribeUrl = subscribeUrl
		}

		this.cacheEnabled = cacheEnabled;
		this.name = name;
		this.db = null;

		(async (name, cacheEnabled) => {
			if (cacheEnabled) {
				this.db = await openDB(name, 1, {
					upgrade(db) {
						// Table for storing subscription token(singular).
						db.createObjectStore("subscriptionTokens", { autoIncrement: true });

						// Table for storing subscribers.
						db.createObjectStore("subscribersMetadata", { autoIncrement: true });
					}
				});
			}
		})(this.name, this.cacheEnabled);
	}

	async authorizeSubscriber(subscriptionData = null, cacheEnabled = this.cacheEnabled) {
		if (!this.cacheEnabled || !cacheEnabled) {
			const subscriptionToken = await this.fetcher(subscriptionData);
			const decodedToken = jwtDecode(subscriptionToken);
			return new AuthorizedSubscriber(
				subscriptionToken, 
				{ ...DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS, serverUrl: this.subscribeUrl }, 
				null, 
				this.fetcher, 
				this.cacheEnabled, 
				decodedToken, 
				this.name
			);
		}

		let subscriptionToken;

		let subscriberKey = JSON.stringify(subscriptionData);
		
		const cachedSubscriptionToken = await this.db.get("subscriptionTokens", subscriberKey);
		
		if (!cachedSubscriptionToken) {
			// Cache subscriptionToken if it isn't cached
			subscriptionToken = await this.fetcher(subscriptionData);
			await this.db.put("subscriptionTokens", subscriptionToken, subscriberKey);
		} else {
			// Use the cached subscription token
			subscriptionToken = cachedSubscriptionToken;
		}

		let decodedToken = jwtDecode(subscriptionToken);
		let subscribersMetadata = await this.db.getAll("subscribersMetadata");

		if (decodedToken.exp < Math.floor(Date.now() / 1000)) {
			// If the token is expired, fetch a new one and update the cache.
			subscriptionToken = await this.fetcher(subscriptionData);
			await this.db.put("subscriptionTokens", subscriptionToken, subscriberKey);

			// Clear all the cached subscriber data.
			const subscriberMetadata = subscribersMetadata.find(subscriberMetadata => subscriberMetadata.name === subscriberKey);
			if (subscriberMetadata) {
				const subscriberDb = await openDB(subscriberMetadata.name, 1);
				await subscriberDb.clear(subscriberMetadata.name);
				subscriberDb.close();
			}

			decodedToken = jwtDecode(subscriptionToken);
		}

		if (!subscriptionToken) {
			throw new Error("Cannot authorize subscriber because fetcher function returned null");
		}

		if (typeof subscriptionToken !== 'string') {
			throw new Error(`Cannot authorize subscriber because fetcher function returned a non-string value: ${subscriptionToken}`);
		}

		let subscriberMetadata = subscribersMetadata.find(subscriberMetadata => subscriberMetadata.name === subscriberKey);

		if (!subscriberMetadata) {
			// Cache subscriber metadata if it isn't cached
			subscriberMetadata = { name: subscriberKey }
			await this.db.put("subscribersMetadata", subscriberMetadata);
		}

		return new AuthorizedSubscriber(subscriptionToken, 
			{ ...DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS, serverUrl: this.subscribeUrl }, 
			this.db, 
			this.fetcher, 
			this.cacheEnabled, 
			decodedToken, 
			this.name,
			subscriberMetadata
		);
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
		},
		db,
		fetcherFunc,
		cacheEnabled,
		decodedToken,
		subscriptionManagerName,
		subscriberMetadata
	) {
		this.authorizationToken = authorizationToken;
		this.serverUrl = serverUrl;
		this.shouldReconnect = shouldReconnect;
		this.reconnectTimeout = reconnectTimeout;
		this.maxReconnectTimeout = maxReconnectTimeout;

		this.isSubscribed = false;
		this.isConnected = false;
		this.db = db;
		this.fetcherFunc = fetcherFunc;
		this.cacheEnabled = cacheEnabled;
		this.decodedToken = decodedToken;
		this.name = subscriptionManagerName;
		this.subscriberMetadata = subscriberMetadata;
	}

	/**
	 * @param {function} onMessageCallback a function that is called when a new event batch is received
	 * @returns {AuthorizedSubscriber} the authorized subscriber
	*/
	subscribe(onEventBatchReceivedCallback) {
		if (this.isSubscribed) {
			return;
		}

		this.ws = new WebSocket(`${this.serverUrl}`, [this.authorizationToken]);

		this.isSubscribed = true;

		if (this.cacheEnabled) {
				(async () => {
					const subscriberDb = await openDB(this.subscriberMetadata.name, 1, {
						upgrade(db) {
							db.createObjectStore(db.name, { autoIncrement: true });
						}
					});
				
					const events = await (subscriberDb.transaction(this.subscriberMetadata.name, 'readwrite').objectStore(this.subscriberMetadata.name).getAll());
					events.forEach(eventBatch => {
						onEventBatchReceivedCallback(eventBatch);
					});

					this.ws.onmessage = eventBatchRawJson => {
						const parsedEventBatch = JSON.parse(eventBatchRawJson.data);
						if (parsedEventBatch.length <= 0) {
							return;
						}
						onEventBatchReceivedCallback(parsedEventBatch);
						subscriberDb.transaction(this.subscriberMetadata.name, 'readwrite').objectStore(this.subscriberMetadata.name).add(parsedEventBatch);
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

						if (!this.shouldReconnect) {
							subscriberDb.close();
						}
					};
			
					this.ws.onerror = (error) => {
						console.error('Exoquic subscription error:', error);
					};
	
					
				})();
		} else {

			this.ws.onmessage = eventBatchRawJson => {
				const parsedEventBatch = JSON.parse(eventBatchRawJson.data);
				onEventBatchReceivedCallback(parsedEventBatch);
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
			
		}

		return this;
	}

	unsubscribe() {
		this.isSubscribed = false;
		this.ws.close(1000, "unsubscribe");
	}

}
