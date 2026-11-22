//! Saved first prompts. Their text is editing content, so saving never trims it.
use crate::reducer::ImageRef;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Attachment {
    pub id: String,
    pub path: String,
    pub name: String,
    pub media_type: String,
    pub size: i64,
    pub sha256: String,
}

impl Attachment {
    pub fn json(&self) -> Value {
        json!({"id":self.id,"path":self.path,"name":self.name,"mediaType":self.media_type,"size":self.size,"sha256":self.sha256})
    }
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Draft {
    pub text: String,
    #[serde(deserialize_with = "images")]
    pub images: Vec<ImageRef>,
    pub revision: i64,
    pub context: Option<String>,
    #[serde(deserialize_with = "crate::wire::list")]
    pub attachments: Vec<Attachment>,
}

fn images<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<ImageRef>, D::Error> {
    let value = Value::deserialize(d)?;
    Ok(value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(ImageRef::decode)
        .collect())
}

pub fn save_params(
    id: &str,
    text: &str,
    images: &[ImageRef],
    attachments: &[Attachment],
    revision: i64,
) -> Value {
    json!({"threadId":id,"text":crate::composer::message_text(text,1),"images":images.iter().map(|i| json!({"path":i.path,"mediaType":i.media_type})).collect::<Vec<_>>(),
        "attachments":attachments.iter().map(Attachment::json).collect::<Vec<_>>(),"revision":revision})
}
