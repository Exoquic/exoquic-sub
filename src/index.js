import { openDB } from "idb";
import { jwtDecode } from "jwt-decode";

export class SubscriptionManager {
	/**
	 * @param {function} fetcher a function that fetches the authorized subscriptiom token from your backend
	 * @param {string} env the environment to use. "dev" for development or "prod" for production
	 * @param {string} name the name of the subscription manager. An IndexedDB database will be created with this name.
	*/
	constructor(fetcher = () => { throw new Error("Missing fetcher function") }, { env, subscribeUrl, name, cacheEnabled } = { env: "dev", name: "default", cacheEnabled: true }) {
		this.fetcher = fetcher;
		if (!subscribeUrl) {
			this.subscribeUrl = `https://${env}.exoquic.com/subscribe`
		} else {
			this.subscribeUrl = subscribeUrl
		}

		this.cacheEnabled = cacheEnabled;
		this.name = name;
	}

	async authorizeSubscriber(subscriptionData = null) {
		if (!this.cacheEnabled) {
			const subscriptionToken = await this.fetcher(subscriptionData);
			const decodedToken = jwtDecode(subscriptionToken);
			return new AuthorizedSubscriber(subscriptionToken, { ...DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS, serverUrl: this.subscribeUrl }, null, this.fetcherFunc, this.cacheEnabled, decodedToken, this.name);
		}

		const cachedSubscriptionToken = localStorage.getItem(`${this.name}.${JSON.stringify(subscriptionData)}`);

		let subscriptionToken = cachedSubscriptionToken;
		let decodedToken;

		if (!subscriptionToken) {
			subscriptionToken = await this.fetcher(subscriptionData);
			localStorage.setItem(`${this.name}.${JSON.stringify(subscriptionData)}`, subscriptionToken);
		}
		
		decodedToken = jwtDecode(subscriptionToken);

		if (decodedToken.exp < Math.floor(Date.now() / 1000)) {
			subscriptionToken = await this.fetcher(subscriptionData);
			localStorage.setItem(`${this.name}.${JSON.stringify(subscriptionData)}`, subscriptionToken);
			decodedToken = jwtDecode(subscriptionToken);
		}

		if (!subscriptionToken) {
			throw new Error("Cannot authorize subscriber because fetcher function returned null");
		}

		if (typeof subscriptionToken !== 'string') {
			throw new Error(`Cannot authorize subscriber because fetcher function returned a non-string value: ${subscriptionToken}`);
		}

		return new AuthorizedSubscriber(subscriptionToken, { ...DEFAULT_AUTHORIZED_SUBSCRIPTION_SETTINGS, serverUrl: this.subscribeUrl }, null, this.fetcherFunc, this.cacheEnabled, decodedToken, this.name);
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
		name
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
		this.name = name;
	}

	/**
	 * @param {function(object, object)} onEventBatchReceivedCallback a function that is called when a new event batch is received. Takes two parameters:
	 * @param {object} eventBatch the event batch
	 * @param {object} db the database
	 */
	subscribeWithDb(onEventBatchReceivedCallback) {
		if (this.isSubscribed) {
			return;
		}

		this.isSubscribed = true;

		this.ws = new WebSocket(`${this.serverUrl}`, [this.authorizationToken]);

		this.ws.onmessage = eventBatchRawJson => {
			const parsedEventBatch = JSON.parse(eventBatchRawJson.data);
			onEventBatchReceivedCallback(parsedEventBatch, this.db);
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
				let storeName = `${this.decodedToken.topic}.${this.decodedToken.channel}.${this.decodedToken.subscriptionId}`;

				this.db = await openDB(this.name, 1, {
					upgrade(db) {
						if (!db.objectStoreNames.contains(storeName)) {
							db.createObjectStore(storeName, { autoIncrement: true });
						}
					}
				});

				const events = await (this.db.transaction(storeName, 'readwrite').objectStore(storeName).getAll());

				events.forEach(eventBatch => {
					onEventBatchReceivedCallback(eventBatch);
				});

				this.ws.onmessage = eventBatchRawJson => {
					const parsedEventBatch = JSON.parse(eventBatchRawJson.data);
					onEventBatchReceivedCallback(parsedEventBatch);
					this.db.transaction(storeName, 'readwrite').objectStore(storeName).add(parsedEventBatch);
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
