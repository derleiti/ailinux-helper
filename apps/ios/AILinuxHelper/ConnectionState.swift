import Foundation

enum HelperConnectionState: String, Codable {
    case connected, reconnecting, suspended, offline
}

struct HelperConnectionSnapshot: Codable {
    var state: HelperConnectionState
    var leaseID: String
    var lastConnectedAt: Date?
}
