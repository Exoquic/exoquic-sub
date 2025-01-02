import { deleteDB, openDB } from "idb";
import { jwtDecode } from "jwt-decode";

export class SubscriptionManager {
	/**
	 * @param {function} fetcher a function that fetches the authorized subscriptiom token from your backend
	 * @param {string} env the environment to use. "dev" for development or "prod" for production
	 * @param {string} name the name of the subscription manager. An IndexedDB database will be created with this name.
	*/
	constructor(fetcher = () => { throw new Error("Missing fetcher function") }, { env = "dev", subscribeUrl, name = "default", cacheEnabled = true, cachedSubscribers = [] }) {
		this.fetcher = fetcher;
		if (!subscribeUrl) {
			this.subscribeUrl = `https://${env}.exoquic.com/subscribe`
		} else {
			this.subscribeUrl = subscribeUrl
		}

		this.cacheEnabled = cacheEnabled;
		this.name = name;
		this.cachedSubscribers = cachedSubscribers ?? [];

		this.db = null;
		if (this.cacheEnabled && this.cachedSubscribers.length == 0) {
			console.warn("Caching is enabled but provided no subscribers to cache. Will ignore caching for all subscribers.");
		}


		(async (cachedSubscribers, name, cacheEnabled) => {
			// Delete database if cached subscribers and provided cached subscribers are different.
			if (this.cachedSubscribers.length > 0) {
				const dbExists = (await indexedDB.databases()).map(db => db.name).includes(name);
				if (dbExists) {
					this.db = await openDB(name, 1);
					const subscribers = await this.db.get("subscribers", "0");
					if (subscribers !== JSON.stringify(cachedSubscribers)) {
						await deleteDB(name);
					}
				}
			}

			if (cacheEnabled) {
				this.db = await openDB(name, 1, {
					upgrade(db) {
						// Table for storing subscription token(singular).
						db.createObjectStore("subscriptionTokens", { autoIncrement: true });

						// Table for storing subscribers.
						db.createObjectStore("subscribers", { autoIncrement: true });
						// Create a table for each subscriber where the event batches are stored.
						for (const subscriber of cachedSubscribers) {
							if (!subscriber.name) {
								throw new Error(`Cached subscriber ${subscriber} is missing a name.`);
							}

							db.createObjectStore(subscriber.name, { autoIncrement: true });
						}
					}
				});
				this.db.put("subscribers", JSON.stringify(cachedSubscribers), "0");
			}
		})(this.cachedSubscribers, this.name, this.cacheEnabled);
	}

	async authorizeSubscriber(subscriberName = null, subscriptionData = null) {
		if (this.cachedSubscribers && subscriberName == null) {
			console.warn(`Missing subscriber name. Will ignore caching for subscriber.`);
		}

		if (!this.cacheEnabled || subscriberName == null) {
			const subscriptionToken = await this.fetcher(subscriptionData);
			const decodedToken = jwtDecode(subscriptionToken);
			return new AuthorizedSubscriber(
				subscriptionToken, 
				{ ...DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS, serverUrl: this.subscribeUrl }, 
				null, 
				this.fetcher, 
				this.cacheEnabled, 
				decodedToken, 
				this.name, 
				subscriberName
			);
		}

		let subscriptionToken;

		const cachedSubscriptionToken = await this.db.get("subscriptionTokens", "0");
		if (!cachedSubscriptionToken) {
			subscriptionToken = await this.fetcher(subscriptionData);
			await this.db.put("subscriptionTokens", subscriptionToken, "0");
		} else {
			subscriptionToken = cachedSubscriptionToken;
		}
		
		let decodedToken = jwtDecode(subscriptionToken);

		if (decodedToken.exp < Math.floor(Date.now() / 1000)) {
			subscriptionToken = await this.fetcher(subscriptionData);
			await this.db.put("subscriptionTokens", subscriptionToken, "0");
			for (const subscriber of this.cachedSubscribers) {
				await this.db.clear(subscriber.name);
			}
			decodedToken = jwtDecode(subscriptionToken);
		}

		if (!subscriptionToken) {
			throw new Error("Cannot authorize subscriber because fetcher function returned null");
		}

		if (typeof subscriptionToken !== 'string') {
			throw new Error(`Cannot authorize subscriber because fetcher function returned a non-string value: ${subscriptionToken}`);
		}

		return new AuthorizedSubscriber(subscriptionToken, 
			{ ...DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS, serverUrl: this.subscribeUrl }, 
			this.db, 
			this.fetcherFunc, 
			this.cacheEnabled, 
			decodedToken, 
			this.name,
			subscriberName
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
		subscriberName
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
		this.subscriberName = subscriberName;
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

		if (this.cacheEnabled && this.subscriberName) {
			// Check if the store exists. If not, then retrieve the events from exoquic.
			const storeExists = this.db.objectStoreNames.contains(this.subscriberName);
			if (storeExists) {
				(async () => {

					const events = await (this.db.transaction(this.subscriberName, 'readwrite').objectStore(this.subscriberName).getAll());
					events.forEach(eventBatch => {
						onEventBatchReceivedCallback(eventBatch);
					});

					this.ws.onmessage = eventBatchRawJson => {
						const parsedEventBatch = JSON.parse(eventBatchRawJson.data);
						onEventBatchReceivedCallback(parsedEventBatch);
						this.db.transaction(this.subscriberName, 'readwrite').objectStore(this.subscriberName).add(parsedEventBatch);
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
	
					
				})();
			}
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
