import {BlockNoteSchema,defaultBlockSpecs} from "@blocknote/core";
import {pageBlock,bookmarkBlock,imageBlock,pdfBlock} from "./CustomBlocks";
const {image:_image,video:_video,audio:_audio,file:_file,...textBlocks}=defaultBlockSpecs;
export const noteSchema=BlockNoteSchema.create({blockSpecs:{...textBlocks,nouPage:pageBlock(),nouBookmark:bookmarkBlock(),nouImage:imageBlock(),nouPdf:pdfBlock()}});
