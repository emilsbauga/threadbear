import CryptoKit
import Foundation
import Security

// The phone's half of a secret card (docs/protocol/threads.md, "Secrets"): the
// value is sealed here to the runner's X25519 key, so the Convex mirror in
// between only ever carries ciphertext. Nothing in this file logs, keeps or
// returns the value in the clear.

/// A secret sealed to a runner's key: what `phone:secret` takes as `sealed`.
/// All three are standard base64, padded.
public struct SealedSecret: Sendable, Hashable {
    /// The phone's ephemeral X25519 public key, raw.
    public var epk: String
    /// The 12-byte AES-GCM nonce.
    public var nonce: String
    /// The ciphertext, then the 16-byte tag.
    public var box: String

    public init(epk: String, nonce: String, box: String) {
        self.epk = epk
        self.nonce = nonce
        self.box = box
    }
}

/// What the phone sends for a secret card.
public enum SecretAnswer: Sendable, Hashable {
    case sealed(SealedSecret)
    case decline
}

public enum SecretSealError: Error, Equatable {
    /// The card's `key` isn't base64 of a 32-byte X25519 public key.
    case badKey
}

/// The seal (docs/protocol/threads.md, "The seal"): an ephemeral X25519 key agrees a
/// shared secret with the runner's, HKDF-SHA256 (salt epk ‖ key, info
/// "threadbear secret v1 <approvalId>") makes a 32-byte key, and
/// AES-256-GCM seals the UTF-8 value with a random 12-byte nonce. The
/// approval id in the info means a sealed answer can't be replayed onto
/// another card. Must match runner/src/secrets.ts byte for byte.
public enum SecretSeal {
    public static func seal(
        _ value: String, toKey runnerKey: String, approvalId: String,
        ephemeral: Curve25519.KeyAgreement.PrivateKey = .init(),
        nonce nonceBytes: Data? = nil
    ) throws -> SealedSecret {
        guard let keyData = Data(base64Encoded: runnerKey), keyData.count == 32,
              let recipient = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: keyData) else {
            throw SecretSealError.badKey
        }
        let epk = ephemeral.publicKey.rawRepresentation
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipient)
        let key = shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: epk + recipient.rawRepresentation,
            sharedInfo: Data("threadbear secret v1 \(approvalId)".utf8),
            outputByteCount: 32)
        let nonce = try nonceBytes.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let sealed = try AES.GCM.seal(Data(value.utf8), using: key, nonce: nonce)
        return SealedSecret(
            epk: epk.base64EncodedString(),
            nonce: Data(nonce).base64EncodedString(),
            box: (sealed.ciphertext + sealed.tag).base64EncodedString())
    }

    /// Whether a card's `key` is one the phone could seal to.
    public static func isUsableKey(_ key: String) -> Bool {
        guard let data = Data(base64Encoded: key), data.count == 32 else { return false }
        return (try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: data)) != nil
    }
}

// MARK: Trusting the key

/// Where each runner's key is kept, and the runner each thread was first
/// seen on.
public protocol RunnerKeyStore: Sendable {
    func key(for runnerId: String) -> String?
    /// Keeps a runner's key, replacing one kept before. Only a pairing
    /// link calls this (`RunnerKeyPins.pinFromPairing`), never a card.
    func save(_ key: String, for runnerId: String)
    func runner(forThread threadId: String) -> String?
    /// Only ever adds: a thread already pinned keeps its first runner.
    func saveRunner(_ runnerId: String, forThread threadId: String)
}

/// Which runner keys a secret may be sealed to (docs/protocol/threads.md,
/// "Trusting the key"). Everything on a secret card (the thread's runner
/// id and the key) comes from the Convex mirror, which anyone holding the
/// shared runner key can write. So trust has to come from outside it:
///
/// - Each runner's key: kept only from a pairing link (the QR code the
///   Mac shows, which carries its runner id and key), or from before this
///   rule, when the first key a card carried was kept. A card for a runner
///   with no kept key is refused (`.unknown`), and one with a different
///   key from the kept one too (`.changed`). Cards never add a key.
/// - Each thread's runner: the first runner id the phone sees a thread on
///   (in a list, or on a secret card it trusted) is kept, and a card whose
///   thread has since changed runner is refused (`.moved`), since runners
///   never take over each other's threads (a handover keeps the runner id).
public enum RunnerKeyPins {
    public enum Trust: Sendable, Equatable {
        /// The kept key for this runner.
        case trusted
        /// Not the key this phone kept for that runner.
        case changed
        /// The thread is on a different runner from the one this phone
        /// first saw it on.
        case moved
        /// A runner this phone has no key for: it wasn't in the pairing
        /// link, so nothing says it's one of Mike's Macs.
        case unknown
    }

    public static func check(_ key: String, runnerId: String, threadId: String, in store: any RunnerKeyStore) -> Trust {
        // First, and before anything is kept, so a moved thread's runner
        // is never pinned off the back of it.
        if let pinned = store.runner(forThread: threadId), pinned != runnerId { return .moved }
        // Nothing is kept from a card: a runner id and key the mirror made
        // up would otherwise be trusted on first sight.
        guard let kept = store.key(for: runnerId) else { return .unknown }
        // Compared as bytes, so a re-encoding of the same key isn't a change.
        guard Data(base64Encoded: kept) == Data(base64Encoded: key) else { return .changed }
        store.saveRunner(runnerId, forThread: threadId)
        return .trusted
    }

    /// Keeps the runner keys a pairing link carried. They come from the
    /// Mac itself, not the mirror, so each replaces whatever was kept for
    /// that runner: pairing again is how a Mac whose key was deleted on
    /// purpose gets answered again. Unusable keys are skipped.
    public static func pinFromPairing(_ keys: [String: String], in store: any RunnerKeyStore) {
        for (runnerId, key) in keys where !runnerId.isEmpty && SecretSeal.isUsableKey(key) {
            if let kept = store.key(for: runnerId), Data(base64Encoded: kept) == Data(base64Encoded: key) { continue }
            store.save(key, for: runnerId)
        }
    }

    /// Pins the runner of each thread not pinned yet, as the lists arrive,
    /// so a thread moved later is caught even if it never had a secret card
    /// before. A thread already pinned elsewhere is left as it was (its next
    /// card is refused as `.moved`).
    public static func noteThreads(_ threads: [(threadId: String, runnerId: String)], in store: any RunnerKeyStore) {
        for t in threads where !t.runnerId.isEmpty && store.runner(forThread: t.threadId) == nil {
            store.saveRunner(t.runnerId, forThread: t.threadId)
        }
    }
}

/// For tests and the demo, which shouldn't leave anything in the keychain.
public final class MemoryRunnerKeyStore: RunnerKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: String] = [:]
    private var threads: [String: String] = [:]
    public init(_ keys: [String: String] = [:], threads: [String: String] = [:]) {
        self.keys = keys
        self.threads = threads
    }
    public func key(for runnerId: String) -> String? { lock.withLock { keys[runnerId] } }
    public func save(_ key: String, for runnerId: String) { lock.withLock { keys[runnerId] = key } }
    public func runner(forThread threadId: String) -> String? { lock.withLock { threads[threadId] } }
    public func saveRunner(_ runnerId: String, forThread threadId: String) {
        lock.withLock { if threads[threadId] == nil { threads[threadId] = runnerId } }
    }
}

/// The real store: one keychain item per runner and one per thread, under
/// the paired deployment, this device only. Only the app reads it (the notification
/// extension never shows a secret card), so there's no access group.
/// Unpairing clears them all (`clearAll`); pairing again keeps the keys its
/// link carries.
public struct KeychainRunnerKeyStore: RunnerKeyStore {
    static let service = "com.mikecann.threadbear.runnerKey"
    /// Thread pins in a service of their own, so a thread id can never be
    /// read as a runner id.
    static let threadService = "com.mikecann.threadbear.threadRunner"
    /// The deployment's host, so the same runner id on two backends is two keys.
    let scope: String

    public init(scope: String) { self.scope = scope }

    private func base(_ id: String, service: String = Self.service) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "\(scope)/\(id)"]
    }

    private func read(_ query: [String: Any]) -> String? {
        var query = query
        query[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func add(_ value: String, _ item: [String: Any]) {
        var item = item
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        // Add only: a pin already kept is never overwritten from here.
        SecItemAdd(item as CFDictionary, nil)
    }

    public func key(for runnerId: String) -> String? { read(base(runnerId)) }
    /// Replaces: only a pairing link's keys come here.
    public func save(_ key: String, for runnerId: String) {
        SecItemDelete(base(runnerId) as CFDictionary)
        add(key, base(runnerId))
    }
    public func runner(forThread threadId: String) -> String? { read(base(threadId, service: Self.threadService)) }
    public func saveRunner(_ runnerId: String, forThread threadId: String) {
        add(runnerId, base(threadId, service: Self.threadService))
    }

    public static func clearAll() {
        for service in [service, threadService] {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
            SecItemDelete(query as CFDictionary)
        }
    }
}
