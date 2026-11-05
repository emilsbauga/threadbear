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
    let choose: (ComposerSkill) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(6)) {
            HStack {
                Text("Skills").font(.system(size: TypeScale.chip, weight: .medium))
                Spacer()
                Text("↑↓ choose · Return insert · Esc close")
                    .font(.system(size: TypeScale.chip - 1))
                    .foregroundStyle(.secondary)
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
                    .frame(height: min(CGFloat(picker.matches.count) * zoomed(34), zoomed(238)))
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
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: zoomed(14)))
        .overlay(RoundedRectangle(cornerRadius: zoomed(14)).strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
        .padding(.bottom, zoomed(8))
    }
}
