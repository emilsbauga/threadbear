// Another Mac's pictures in a transcript (a tool's screenshots there, a
// picture pasted into one of its messages): their paths are that Mac's, so a
// tile never draws the file here that has the same path, which isn't the one
// meant (Daybreak, 7 Nov). This Mac's runner is asked for it instead
// (`files.read` with the thread's `runnerId`), as the pane asks for that Mac's
// files, and the tile draws the bytes. A tile with no picture says so
// quietly, as the Swift app's ImageGridView does: "Loading…", "Couldn't get it
// from bruce" (why, on hover; a click asks again), or "On bruce" for one too
// big to send whole.
//
// Through Convex, the only way this app reaches another Mac so far, the
// runner gives a message the pictures pasted into it that Mac put up
// (backend API 87, runner/src/relay.ts), and answers `files.read` for one
// from the backend's file storage; a picture that never went up has a
// `threadbear-relay:` path and says why when asked. Tools' pictures still
// stay on that Mac: "Files on another runner are kept there for now." A
// message sent from here draws its pictures from this runner's inbox, which
// the runner answers for too, until that Mac shows the message.
use crate::call;
use gpui_kit::*;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use threadbear_client::runner::Client;
use threadbear_core::folders::FileRead;

/// Biggest picture asked for whole (`files.read`'s own default).
pub(crate) const MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone)]
pub(crate) enum Picture {
    Loading,
    /// Decoded within the budget (fit_picture.rs) and kept in its books.
    Ready(Arc<RenderImage>),
    /// Over the size cap: only its start came, which won't draw.
    Truncated,
    Failed(String),
}

/// Where a remote picture has got. A ready one's pixels are in
/// fit_picture.rs's books, not here, so they go when the books need the room
/// and are asked for again when next drawn.
#[derive(Clone)]
enum State {
    Loading,
    Ready,
    Truncated,
    Failed(String),
    /// No room for it with the pictures on screen: asked again in a while.
    Busy,
}

/// Every remote picture asked for since launch, by runner and path.
#[derive(Default)]
struct RemotePictures {
    pictures: HashMap<(String, String), State>,
}

/// Its key in fit_picture.rs's books.
fn kept_key(runner: &str, path: &str) -> String {
    format!("remote\n{runner}\n{path}")
}

/// The picture as `picture` hands it out: a ready one from the books, or
/// None when the books have let it go.
fn shown(state: &State, runner: &str, path: &str) -> Option<Picture> {
    Some(match state {
        State::Loading => Picture::Loading,
        State::Ready => Picture::Ready(crate::fit_picture::drawn(&kept_key(runner, path))?.0),
        State::Truncated => Picture::Truncated,
        State::Failed(why) => Picture::Failed(why.clone()),
        State::Busy => Picture::Loading,
    })
}

impl Global for RemotePictures {}

/// The picture as far as it's got, asking for it the first time. `redraw`
/// is told when it comes.
pub(crate) fn picture(
    runner: &str,
    path: &str,
    client: &Arc<Client>,
    redraw: AnyWeakEntity,
    cx: &mut App,
) -> Picture {
    asked(runner, path, client, Some(redraw), cx)
}

/// The picture as an `img` draws it, asked for as a tile asks: for the
/// viewer, which shows the one a tile's click opens from the same books
/// (fit_picture.rs), not asking that Mac again while they still have it.
pub(crate) fn source(runner: String, path: String, client: Arc<Client>) -> ImageSource {
    ImageSource::Custom(Arc::new(move |_window, cx| {
        match asked(&runner, &path, &client, None, cx) {
            Picture::Ready(image) => Some(Ok(image)),
            Picture::Loading => None,
            Picture::Truncated => Some(Err(std::io::Error::other(
                "It's too big to send from that Mac.",
            )
            .into())),
            Picture::Failed(why) => Some(Err(std::io::Error::other(why).into())),
        }
    }))
}

fn asked(
    runner: &str,
    path: &str,
    client: &Arc<Client>,
    redraw: Option<AnyWeakEntity>,
    cx: &mut App,
) -> Picture {
    let key = (runner.to_owned(), path.to_owned());
    if let Some(found) = cx.default_global::<RemotePictures>().pictures.get(&key) {
        if let Some(picture) = shown(found, runner, path) {
            return picture;
        }
    }
    cx.default_global::<RemotePictures>()
        .pictures
        .insert(key.clone(), State::Loading);
    let (client, params) = (
        client.clone(),
        json!({ "path": path, "runnerId": runner, "maxBytes": MAX_BYTES }),
    );
    cx.spawn(async move |cx| {
        // A turn first: at most a few answers held whole before they're
        // decoded (fit_picture.rs).
        let mut turn = crate::fit_picture::reader(
            crate::fit_picture::Reads::Remote,
            crate::fit_picture::answer_bytes(MAX_BYTES),
            cx,
        )
        .await;
        let answer = call(client, "files.read", params).await;
        // Off this thread, and not past what was asked for (FileRead).
        let answer = match answer {
            Ok(value) => Ok(cx
                .background_executor()
                .spawn(async move { FileRead::decode_at_most(&value, MAX_BYTES) })
                .await),
            Err(e) => Err(e),
        };
        let state = match answer {
            Ok(read) => match read {
                Some(read) if read.truncated => State::Truncated,
                // Its runner's word on the cap isn't taken for it.
                Some(read) if read.data.len() as u64 > MAX_BYTES => State::Truncated,
                Some(read) => match crate::viewer::format_of(&key.1, &read.data) {
                    // Decoded within the budget, off this thread (fit_picture.rs).
                    Some(_) => {
                        turn.read(read.data.len() as u64);
                        let kept = kept_key(&key.0, &key.1);
                        let bytes: crate::fit_picture::Bytes = Arc::new(read.data);
                        match crate::fit_picture::decode_kept(kept, bytes, false, turn, cx).await {
                            Ok(()) => State::Ready,
                            // Asked again once there may be room (fit_picture.rs).
                            Err(crate::fit_picture::Refused::Busy) => State::Busy,
                            Err(refused) => State::Failed(refused.to_string()),
                        }
                    }
                    _ => State::Failed("It isn't a picture this app can show.".into()),
                },
                None => State::Failed("Couldn't read the runner's answer.".into()),
            },
            Err(e) => State::Failed(e.message),
        };
        let busy = matches!(state, State::Busy);
        if busy {
            // Forgotten in a while, so the next draw asks again.
            let again = key.clone();
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(30))
                    .await;
                cx.update(|cx| {
                    let pictures = &mut cx.default_global::<RemotePictures>().pictures;
                    if matches!(pictures.get(&again), Some(State::Busy)) {
                        pictures.remove(&again);
                    }
                    cx.refresh_windows();
                });
            })
            .detach();
        }
        cx.update(|cx| {
            cx.default_global::<RemotePictures>()
                .pictures
                .insert(key, state);
            match redraw.and_then(|r| r.upgrade()) {
                Some(entity) => cx.notify(entity.entity_id()),
                None => cx.refresh_windows(),
            }
        });
    })
    .detach();
    Picture::Loading
}

/// Drawn already: the picture's own size, for the viewer (viewer.rs).
pub(crate) fn ready_size(runner: &str, path: &str, cx: &App) -> Option<(u32, u32)> {
    match cx
        .try_global::<RemotePictures>()?
        .pictures
        .get(&(runner.to_owned(), path.to_owned()))?
    {
        State::Ready => crate::fit_picture::drawn(&kept_key(runner, path)).map(|(_, size)| size),
        _ => None,
    }
}

/// A picture the other Mac hasn't put up (yet): the runner's place for it,
/// `threadbear-relay:<thread>/<seq>/Picture N` (runner/src/relay.ts).
pub(crate) fn not_up_yet(path: &str) -> bool {
    path.starts_with("threadbear-relay:")
}

/// A click on one that couldn't be got: asked for again on the next draw.
pub(crate) fn retry(runner: &str, path: &str, cx: &mut App) {
    let key = (runner.to_owned(), path.to_owned());
    let pictures = &mut cx.default_global::<RemotePictures>().pictures;
    if matches!(pictures.get(&key), Some(State::Failed(_))) {
        pictures.remove(&key);
    }
}

/// What a tile with no picture says (`remoteWords`).
pub(crate) fn words(picture: &Picture, runner_name: &str) -> Option<String> {
    match picture {
        Picture::Loading => Some("Loading…".into()),
        Picture::Truncated => Some(format!("On {runner_name}")),
        Picture::Failed(_) => Some(format!("Couldn't get it from {runner_name}")),
        Picture::Ready(_) => None,
    }
}

/// The picture as far as it's got, without asking for it.
#[cfg(feature = "automation")]
pub(crate) fn peek(runner: &str, path: &str, cx: &App) -> Option<Picture> {
    let state = cx
        .try_global::<RemotePictures>()?
        .pictures
        .get(&(runner.to_owned(), path.to_owned()))?;
    shown(state, runner, path)
}

/// `tiles`, as the Swift app's: what each picture of the last row of at
/// least `count` says, "picture" for one that's drawn, else its words.
#[cfg(feature = "automation")]
pub(crate) fn tiles_command(
    app: &Entity<crate::app::Threadbear>,
    cmd: &serde_json::Value,
    cx: &mut App,
) -> Result<serde_json::Value, String> {
    let count = cmd["count"].as_u64().unwrap_or(1) as usize;
    let (images, runner) = app.update(cx, |t, cx| {
        t.update_pane(cx, |p, _| {
            p.last_row_images(count)
                .map(|images| (images, p.summary.runner_id.clone()))
        })
    })??;
    let name = runner
        .as_deref()
        .map(|id| app.read(cx).runner_name_of(id))
        .unwrap_or_default();
    let said: Vec<String> = images
        .iter()
        .map(|image| match &runner {
            None => "picture".to_owned(),
            // Not asked for yet is on its way, as the Swift tile says it.
            Some(runner) => peek(runner, &image.path, cx)
                .map_or_else(|| Some("Loading…".to_owned()), |p| words(&p, &name))
                .unwrap_or_else(|| "picture".to_owned()),
        })
        .collect();
    Ok(json!(format!("ok {}", said.join(" | "))))
}

/// `tile-point`: where a picture tile's middle is (`index` of the last row of
/// at least `count`), with its file's name: "ok x y name.png".
#[cfg(feature = "automation")]
pub(crate) fn tile_point_command(
    app: &Entity<crate::app::Threadbear>,
    cmd: &serde_json::Value,
    window: &mut Window,
    cx: &mut App,
) -> Result<serde_json::Value, String> {
    use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
    let count = cmd["count"].as_u64().unwrap_or(1) as usize;
    let index = cmd["index"].as_u64().unwrap_or(0) as usize;
    let images = app.update(cx, |t, cx| {
        t.update_pane(cx, |p, _| p.last_row_images(count))
    })??;
    let image = images.get(index).ok_or("no such picture")?;
    let name = std::path::Path::new(&image.path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    window.render_frame(cx);
    // A tile's label is its file's name (rows/images.rs).
    let tile = window
        .find_all_by_label(&name)
        .into_iter()
        .filter(|e| e.visible())
        .next_back()
        .ok_or("that picture isn't on screen")?;
    let (x, y) = crate::automation::whole_point(tile.visible_bounds())
        .ok_or("that picture isn't on screen")?;
    Ok(json!(format!("ok {x} {y} {name}")))
}
