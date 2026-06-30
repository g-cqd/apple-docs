public import ADJSONCore

extension JSON {
    /// The member value for `key`, or nil when this node isn't an object or the key
    /// is absent. ADJSON's subscript returns a missing sentinel; the renderers want
    /// the `Optional` shape so `if let x = node.member("k")` reads as "present".
    public func member(_ key: String) -> JSON? {
        guard isObject else { return nil }
        let value = self[key]
        return value.exists ? value : nil
    }

    /// First array element, or nil for a non-array / empty array.
    public var firstElement: JSON? {
        guard isArray, count > 0 else { return nil }
        let value = self[index: 0]
        return value.exists ? value : nil
    }
}
