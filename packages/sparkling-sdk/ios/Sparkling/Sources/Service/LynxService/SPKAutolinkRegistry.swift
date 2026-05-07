// Copyright 2026 The Sparkling Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import Foundation
import Lynx

public final class SPKAutolinkRegistry {
    public static let shared = SPKAutolinkRegistry()

    private struct ElementRegistration {
        let name: String
        let type: AnyClass
    }

    private struct ModuleRegistration {
        let name: String
        let type: LynxModule.Type
        let param: Any?
    }

    private let lock = NSLock()
    private var elements: [String: ElementRegistration] = [:]
    private var modules: [String: ModuleRegistration] = [:]
    private var serviceRegistrars: [() -> Void] = []
    private var didApplyServices = false

    private init() {}

    public func registerElement(name: String, type: AnyClass) {
        withLock {
            elements["\(name):\(ObjectIdentifier(type).hashValue)"] = ElementRegistration(name: name, type: type)
        }
    }

    public func registerModule(name: String, type: LynxModule.Type, param: Any? = nil) {
        withLock {
            modules["\(name):\(ObjectIdentifier(type).hashValue)"] = ModuleRegistration(name: name, type: type, param: param)
        }
    }

    public func registerService(_ registrar: @escaping () -> Void) {
        withLock {
            serviceRegistrars.append(registrar)
        }
    }

    public func applyServicesOnce() {
        let registrars: [() -> Void] = withLock {
            guard !didApplyServices else { return [] }
            didApplyServices = true
            return serviceRegistrars
        }
        registrars.forEach { $0() }
    }

    func applyModules(to config: LynxConfig?) {
        guard let config else { return }
        let registrations = withLock { Array(modules.values) }
        registrations.forEach { registration in
            config.register(registration.type, param: registration.param)
        }
    }

    func applyElements(to view: SPKWrapperLynxViewProtocol) {
        let registrations = withLock { Array(elements.values) }
        registrations.forEach { registration in
            view.register(withUI: registration.type, withName: registration.name)
        }
    }

    private func withLock<T>(_ block: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return block()
    }
}
