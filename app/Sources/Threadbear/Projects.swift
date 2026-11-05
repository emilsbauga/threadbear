import AppKit
import ThreadbearCore
import UniformTypeIdentifiers

/// Projects and the librarian (docs/protocol.md, "Projects"): loading them,
/// the project page, and what Mike can do to them by hand.
extension AppModel {
    // MARK: Loading

    /// The list and the librarian after hello; `projects.updated` and
    /// `librarian.updated` keep them current from then on.
    func loadProjects() {
        guard let client else { return }
        Task {
            do {
                receive(projects: try await client.listProjects(archived: true))
            } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
                // A runner from before projects: none of it shows.
                projectsSupported = false
                projects = []
                librarian = nil
                openProjectId = nil
                showsProjectsHome = false
                showsLibrarianHome = false
                if sidebarMode == .projects || sidebarMode == .librarian { sidebarMode = .inbox }
                return
            } catch {
                AppLog.write("rpc", "projects.list failed: \(error.localizedDescription)")
                return
            }
            do {
                librarian = try await client.librarianStatus()
            } catch {
                AppLog.write("rpc", "librarian.status failed: \(error.localizedDescription)")
            }
        }
    }

    func receive(projects list: [Project]) {
        projects = list
        projectsSupported = true
        // Merged into another or deleted: the page has nothing to show.
        if let open = openProjectId, !list.contains(where: { $0.id == open }) { openProjectId = nil }
    }

    func project(_ id: String) -> Project? { projects.first { $0.id == id } }

    var openProject: Project? { openProjectId.flatMap(project) }

    var projectCards: [ProjectCard] { ProjectCard.build(projectSections) }

    /// Projects a thread could be put in: the live ones it isn't in.
    func projectsToAdd(_ thread: ThreadSummary) -> [Project] {
        projects.filter { project in !project.archived && !thread.projects.contains { $0.id == project.id } }
            .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    /// The Projects view in the sidebar, and its page of cards in the
    /// detail area. The thread that was showing stays selected, so ⌘1
    /// goes back to it.
    func showProjects() {
        sidebarMode = .projects
        openProjectId = nil
        showsProjectsHome = true
    }

    /// The Librarian view in the sidebar, and its page in the detail area.
    func showLibrarian() {
        sidebarMode = .librarian
        openProjectId = nil
        showsLibrarianHome = true
    }

    /// The project's page in the detail area. The sidebar stays where it is.
    func openProjectPage(_ id: String) {
        guard project(id) != nil else { return }
        openProjectId = id
        showsProjectsHome = false
        showsLibrarianHome = false
        showsScheduledHome = false
    }

    // MARK: Changing a project

    /// Saves what's given. The reply goes in straight away;
    /// `projects.updated` brings the whole list a moment later anyway.
    func updateProject(_ id: String, _ update: ProjectUpdate) {
        guard let client else { return }
        Task {
            do {
                replace(try await client.updateProject(id, update))
            } catch {
                show(error)
            }
        }
    }

    func setProjectArchived(_ id: String, _ archived: Bool) {
        updateProject(id, ProjectUpdate(archived: archived))
    }

    /// Asks for a folder and adds it: the project's patches load from it.
    func addProjectFolder(_ id: String) {
        guard let project = project(id) else { return }
        projectFilePicker.choose(configure: { panel in
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.prompt = "Add"
            panel.message = "Add a folder to \(project.title)"
            if let first = project.folders.first { panel.directoryURL = URL(fileURLWithPath: first).deletingLastPathComponent() }
        }) { [weak self] url in
            // The project may have changed while the picker was open.
            guard let self, let url, let current = self.project(id) else { return }
            let path = url.standardizedFileURL.path
            guard !current.folders.contains(path) else { return }
            self.updateProject(id, ProjectUpdate(folders: current.folders + [path]))
        }
    }

    /// Asks for a picture and makes it the project's icon, which the
    /// librarian then leaves alone.
    func chooseProjectIcon(_ id: String) {
        guard let client, let project = project(id) else { return }
        projectFilePicker.choose(configure: { panel in
            panel.canChooseDirectories = false
            panel.canChooseFiles = true
            panel.allowsMultipleSelection = false
            panel.allowedContentTypes = [.png, .jpeg, .webP, .svg, .icns, .ico, .gif, .heic, .tiff]
            panel.prompt = "Use"
            panel.message = "Choose an icon for \(project.title)"
            if let first = project.folders.first { panel.directoryURL = URL(fileURLWithPath: first) }
        }) { [weak self] url in
            guard let self, let url, self.project(id) != nil else { return }
            Task {
                do {
                    self.replace(try await client.setProjectIcon(id, path: url.standardizedFileURL.path))
                } catch {
                    self.show(error)
                }
            }
        }
    }

    /// Back to the icon the librarian finds in the project's folders.
    func setProjectIconAutomatic(_ id: String) {
        guard let client else { return }
        Task {
            do {
                replace(try await client.setProjectIcon(id))
            } catch {
                show(error)
            }
        }
    }

    /// Reads the project's Notion board again. Quiet when it fails: the
    /// board shows the error itself.
    func refreshProjectTasks(_ id: String, force: Bool = false) {
        guard let client, project(id)?.notion != nil else { return }
        Task {
            if let project = try? await client.refreshProjectTasks(id, force: force) { replace(project) }
        }
    }

    /// Asks for the Notion page with the project's task board.
    func linkProjectNotion(_ id: String) {
        guard let project = project(id) else { return }
        let alert = NSAlert()
        alert.messageText = "Notion page for \(project.title)"
        alert.informativeText = "Paste the link to a Notion page with a Tasks database on it, or to the database itself. Leave it empty to take it off."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        field.placeholderString = "https://www.notion.so/…"
        field.stringValue = project.notion ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let url = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard url != (project.notion ?? "") else { return }
        updateProject(id, ProjectUpdate(notion: url))
    }

    func removeProjectFolder(_ id: String, _ folder: String) {
        guard let project = project(id) else { return }
        updateProject(id, ProjectUpdate(folders: project.folders.filter { $0 != folder }))
    }

    /// Asks first: its threads leave it and its notes go.
    func deleteProject(_ id: String) {
        guard let client, let project = project(id) else { return }
        let alert = NSAlert()
        alert.messageText = "Delete \u{201C}\(project.title)\u{201D}?"
        alert.informativeText = "Its threads leave it and its goals, state and notes are gone. The threads and folders aren't touched."
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task {
            do {
                try await client.deleteProject(id)
                projects.removeAll { $0.id == id }
                if openProjectId == id { openProjectId = nil }
            } catch {
                show(error)
            }
        }
    }

    /// Folders and threads move over, notes are joined, and this one goes.
    func mergeProject(_ id: String, into intoId: String) {
        guard let client, let project = project(id), let into = self.project(intoId) else { return }
        let alert = NSAlert()
        alert.messageText = "Merge \u{201C}\(project.title)\u{201D} into \u{201C}\(into.title)\u{201D}?"
        alert.informativeText = "Its folders and threads move to \(into.title), its notes are added to the end of \(into.title)'s, and \(project.title) is deleted."
        alert.addButton(withTitle: "Merge")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task {
            do {
                let kept = try await client.mergeProject(id, into: intoId)
                projects.removeAll { $0.id == id }
                replace(kept)
                if openProjectId == id { openProjectId = kept.id }
            } catch {
                show(error)
            }
        }
    }

    // MARK: A thread's projects

    /// What Mike does by hand: an added project is pinned (so this also
    /// keeps a thread the librarian put somewhere), and a removed one is
    /// never put back.
    func setProjects(_ threadId: String, add: [String] = [], remove: [String] = []) {
        guard let client else { return }
        Task {
            do {
                threads[threadId] = try await client.setThreadProjects(threadId, add: add, remove: remove)
            } catch {
                show(error)
            }
        }
    }

    /// Asks for a name and makes a project with the thread in it. Its
    /// folder goes in too, unless it's the default folder, which is
    /// everyone's scratch space (misc) rather than a project's.
    func newProject(with threadId: String?) {
        guard let client else { return }
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.placeholderString = "Name"
        let alert = NSAlert()
        alert.messageText = "New project"
        alert.informativeText = threadId == nil ? "" : "The thread goes in it."
        alert.accessoryView = field
        alert.addButton(withTitle: "Make project")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let title = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        var folders: [String] = []
        if let threadId, let cwd = threads[threadId]?.cwd, !cwd.isEmpty,
           URL(fileURLWithPath: cwd).standardizedFileURL != URL(fileURLWithPath: defaults.cwd).standardizedFileURL {
            folders = [cwd]
        }
        Task {
            do {
                let project = try await client.createProject(NewProjectRequest(title: title, folders: folders, threadIds: threadId.map { [$0] } ?? []))
                replace(project)
                openProjectId = project.id
            } catch {
                show(error)
            }
        }
    }

    // MARK: The librarian

    func setLibrarianPaused(_ paused: Bool) {
        guard let client else { return }
        Task {
            do {
                librarian = try await client.updateLibrarian(paused: paused)
            } catch {
                show(error)
            }
        }
    }

    /// A look at one thread now, or with none at every thread it has never
    /// looked at.
    func runLibrarian(threadId: String? = nil) {
        guard let client else { return }
        Task {
            do {
                librarian = try await client.runLibrarian(threadId: threadId)
            } catch {
                show(error)
            }
        }
    }

    private func replace(_ project: Project) {
        if let index = projects.firstIndex(where: { $0.id == project.id }) {
            projects[index] = project
        } else {
            projects.insert(project, at: 0)
        }
    }
}
