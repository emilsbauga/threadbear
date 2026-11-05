import AppKit
import SwiftUI
import ThreadbearCore

/// Kept beside the text view so arrows and Return never leave the editor.
@Observable
final class ComposerSkillPicker {
    var token: SkillCompletion.Token?
    var skills: [ComposerSkill] = []
    var errors: [String] = []
    var loading = false
    var selected = 0
    private var dismissed: SkillCompletion.Token?
    var matches: [ComposerSkill] { SkillCompletion.matches(skills, query: token?.query ?? "") }

    func changed(_ view: ComposerTextView) {
        let next = view.hasMarkedText() ? nil : SkillCompletion.token(in: view.string, selection: view.selectedRange())
        if next != dismissed { dismissed = nil }
        let wanted = next == dismissed ? nil : next
        if token != wanted { selected = 0; token = wanted }
    }

    func dismiss() {
        dismissed = token
        token = nil
    }

    func choose(_ skill: ComposerSkill, in view: ComposerTextView?) {
        guard let view, let token,
              SkillCompletion.token(in: view.string, selection: view.selectedRange()) == token else { dismiss(); return }
        // A click can arrive before SwiftUI has repainted a newly typed query.
        guard !loading, matches.contains(where: { $0.id == skill.id }) else { return }
        // Through NSTextView: one undo step, preserving pictures and text.
        dismiss()
        view.insertText("$\(skill.name) ", replacementRange: token.range)
        view.window?.makeFirstResponder(view)
    }

    func key(_ event: NSEvent, in view: ComposerTextView) -> Bool {
        guard token != nil, !view.hasMarkedText(), event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty else { return false }
        switch event.keyCode {
        case 53: dismiss(); return true
        case 125, 126:
            let count = matches.count
            if count > 0 { selected = (selected + (event.keyCode == 125 ? 1 : count - 1)) % count }
            return true
        case 36, 76, 48:
            let rows = matches
            if !loading, rows.indices.contains(selected) { choose(rows[selected], in: view) }
            return true
        default: return false
        }
    }
}

struct ComposerSkillsMenu: View {
    let picker: ComposerSkillPicker
    var maxHeight: CGFloat = 280
    let choose: (ComposerSkill) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(6)) {
            HStack {
                Text("Skills").font(.system(size: TypeScale.chip, weight: .medium)).fixedSize()
                Spacer()
                Text("↑↓ choose · Return insert · Esc close")
                    .font(.system(size: TypeScale.chip - 1))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, zoomed(10))
            if picker.loading {
                Text("Loading skills…").foregroundStyle(.secondary).padding(zoomed(10))
            } else if picker.matches.isEmpty {
                Text(picker.errors.first ?? (picker.skills.isEmpty ? "No skills available for this login and folder." : "No matching skills."))
                    .foregroundStyle(.secondary).padding(zoomed(10))
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: zoomed(2)) {
                            ForEach(Array(picker.matches.enumerated()), id: \.element.id) { index, skill in
                                Button { choose(skill) } label: {
                                    HStack(spacing: zoomed(9)) {
                                        Image(systemName: "shippingbox").foregroundStyle(.secondary)
                                        Text(skill.displayName).lineLimit(1)
                                        Text(skill.description).foregroundStyle(.secondary).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                                        Text(skill.scopeLabel).foregroundStyle(.secondary).font(.system(size: TypeScale.chip))
                                    }
                                    .font(.system(size: TypeScale.chip + 1))
                                    .padding(.horizontal, zoomed(10))
                                    .frame(height: zoomed(32))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contentShape(Rectangle())
                                    .background(index == picker.selected ? Color.primary.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: zoomed(7)))
                                }
                                .buttonStyle(.plain)
                                .tip("$\(skill.name): \(skill.description)\n\(skill.path)")
                                .accessibilityLabel("\(skill.displayName), \(skill.scopeLabel). \(skill.description)")
                                .id(index)
                            }
                        }
                    }
                    .frame(height: min(CGFloat(picker.matches.count) * zoomed(34), zoomed(238), max(zoomed(34), maxHeight - zoomed(picker.errors.isEmpty ? 44 : 68))))
                    .onChange(of: picker.selected) { _, index in proxy.scrollTo(index) }
                    .onChange(of: picker.token?.query) { _, _ in proxy.scrollTo(0) }
                }
                if !picker.errors.isEmpty {
                    Text("Some skills could not be read.").font(.system(size: TypeScale.chip)).foregroundStyle(.secondary)
                        .padding(.horizontal, zoomed(10)).tip(picker.errors.joined(separator: "\n"))
                }
            }
        }
        .padding(zoomed(8))
        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: zoomed(14)))
        .overlay(RoundedRectangle(cornerRadius: zoomed(14)).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.2), radius: zoomed(12), y: zoomed(3))
    }
}

/// Measure in the owning window: SwiftUI's global space can include a
/// dock panel's offset, which overstates room above a short composer.
struct ComposerSkillsSpaceProbe: NSViewRepresentable {
    var changed: (CGFloat) -> Void

    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) {
        view.changed = changed
        DispatchQueue.main.async { [weak view] in view?.report() }
    }

    final class Probe: NSView {
        var changed: ((CGFloat) -> Void)?
        private var lastSpace: CGFloat = -1
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func layout() { super.layout(); report() }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); report() }
        func report() {
            guard let content = window?.contentView else { return }
            let rect = convert(bounds, to: content)
            let above = content.isFlipped ? rect.minY - content.bounds.minY : content.bounds.maxY - rect.maxY
            // Keep the pane's header visible, with the same 8-point gap.
            let space = max(zoomed(80), above - zoomed(48))
            guard abs(space - lastSpace) > 0.5 else { return }
            lastSpace = space
            DispatchQueue.main.async { [weak self] in self?.changed?(space) }
        }
    }
}
