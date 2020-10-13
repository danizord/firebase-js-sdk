/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FirebaseFirestore, FirestoreCompat } from './database';
import {
  MemoryOfflineComponentProvider,
  OfflineComponentProvider,
  OnlineComponentProvider
} from '../../../src/core/component_provider';
import { handleUserChange, LocalStore } from '../../../src/local/local_store';
import { logDebug } from '../../../src/util/log';
import {
  RemoteStore,
  remoteStoreHandleCredentialChange
} from '../../../src/remote/remote_store';
import {
  SyncEngine,
  syncEngineListen,
  syncEngineUnlisten
} from '../../../src/core/sync_engine';
import { Persistence } from '../../../src/local/persistence';
import { EventManager } from '../../../src/core/event_manager';

const LOG_TAG = 'ComponentProvider';

// The components module manages the lifetime of dependencies of the Firestore
// client. Dependencies can be lazily constructed and only one exists per
// Firestore instance.

// Instance maps that ensure that only one component provider exists per
// Firestore instance.
const offlineComponentProviders = new Map<
  FirestoreCompat,
  OfflineComponentProvider
>();
const onlineComponentProviders = new Map<
  FirestoreCompat,
  OnlineComponentProvider
>();

export async function setOfflineComponentProvider(
  firestore: FirestoreCompat,
  offlineComponentProvider: OfflineComponentProvider
): Promise<void> {
  firestore._queue.verifyOperationInProgress();

  logDebug(LOG_TAG, 'Initializing OfflineComponentProvider');
  const configuration = await firestore._getConfiguration();
  await offlineComponentProvider.initialize(configuration);

  firestore._setCredentialChangeListener(user =>
    firestore._queue.enqueueRetryable(() =>
      handleUserChange(offlineComponentProvider.localStore, user).then(() => {})
    )
  );

  // When a user calls clearPersistence() in one client, all other clients
  // need to be terminated to allow the delete to succeed.
  offlineComponentProvider.persistence.setDatabaseDeletedListener(() =>
    firestore._delete()
  );
  offlineComponentProviders.set(firestore, offlineComponentProvider);
}

export async function setOnlineComponentProvider(
  firestore: FirestoreCompat,
  onlineComponentProvider: OnlineComponentProvider
): Promise<void> {
  firestore._queue.verifyOperationInProgress();

  const offlineComponentProvider = await getOfflineComponentProvider(firestore);

  logDebug(LOG_TAG, 'Initializing OnlineComponentProvider');
  const configuration = await firestore._getConfiguration();
  await onlineComponentProvider.initialize(
    offlineComponentProvider,
    configuration
  );

  // The CredentialChangeListener of the online component provider takes
  // precedence over the offline component provider.
  firestore._setCredentialChangeListener(user =>
    firestore._queue.enqueueRetryable(() =>
      remoteStoreHandleCredentialChange(
        onlineComponentProvider.remoteStore,
        user
      )
    )
  );
  onlineComponentProviders.set(firestore, onlineComponentProvider);
}

// TODO(firestore-compat): Remove `export` once compat migration is complete.
export async function getOfflineComponentProvider(
  firestore: FirestoreCompat
): Promise<OfflineComponentProvider> {
  firestore._queue.verifyOperationInProgress();

  if (!offlineComponentProviders.has(firestore)) {
    logDebug(LOG_TAG, 'Using default OfflineComponentProvider');
    await setOfflineComponentProvider(
      firestore,
      new MemoryOfflineComponentProvider()
    );
  }
  return offlineComponentProviders.get(firestore)!;
}

// TODO(firestore-compat): Remove `export` once compat migration is complete.
export async function getOnlineComponentProvider(
  firestore: FirestoreCompat
): Promise<OnlineComponentProvider> {
  firestore._queue.verifyOperationInProgress();

  if (!onlineComponentProviders.has(firestore)) {
    logDebug(LOG_TAG, 'Using default OnlineComponentProvider');
    await setOnlineComponentProvider(firestore, new OnlineComponentProvider());
  }
  return onlineComponentProviders.get(firestore)!;
}

export function getSyncEngine(
  firestore: FirebaseFirestore
): Promise<SyncEngine> {
  return getOnlineComponentProvider(firestore).then(
    components => components.syncEngine
  );
}

export function getRemoteStore(
  firestore: FirestoreCompat
): Promise<RemoteStore> {
  return getOnlineComponentProvider(firestore).then(
    components => components.remoteStore
  );
}

export function getEventManager(
  firestore: FirebaseFirestore
): Promise<EventManager> {
  return getOnlineComponentProvider(firestore).then(components => {
    const eventManager = components.eventManager;
    eventManager.onListen = syncEngineListen.bind(null, components.syncEngine);
    eventManager.onUnlisten = syncEngineUnlisten.bind(
      null,
      components.syncEngine
    );
    return eventManager;
  });
}

export function getPersistence(
  firestore: FirebaseFirestore
): Promise<Persistence> {
  return getOfflineComponentProvider(firestore).then(
    components => components.persistence
  );
}

export function getLocalStore(
  firestore: FirebaseFirestore
): Promise<LocalStore> {
  return getOfflineComponentProvider(firestore).then(
    provider => provider.localStore
  );
}

/**
 * Removes all components associated with the provided instance. Must be called
 * when the Firestore instance is terminated.
 */
export async function removeComponents(
  firestore: FirestoreCompat
): Promise<void> {
  const onlineComponentProviderPromise = onlineComponentProviders.get(
    firestore
  );
  if (onlineComponentProviderPromise) {
    logDebug(LOG_TAG, 'Removing OnlineComponentProvider');
    onlineComponentProviders.delete(firestore);
    await (await onlineComponentProviderPromise).terminate();
  }

  const offlineComponentProviderPromise = offlineComponentProviders.get(
    firestore
  );
  if (offlineComponentProviderPromise) {
    logDebug(LOG_TAG, 'Removing OfflineComponentProvider');
    offlineComponentProviders.delete(firestore);
    await (await offlineComponentProviderPromise).terminate();
  }
}
