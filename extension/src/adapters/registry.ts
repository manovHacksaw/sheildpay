import { Adapter } from "./types";
import { generic } from "./generic";

export function detect(url: URL, doc: Document): Adapter | null {
  return generic.matches(url, doc) ? generic : null;
}
