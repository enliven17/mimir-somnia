import { redirect } from "next/navigation";

/**
 * /markets was a second listing page, next to /explorer, split by which venue a
 * reader happened to want — binaries here, VS claims there. One listing with a
 * tab is the same information without asking the reader to know that.
 *
 * Kept as a redirect rather than deleted: the path is in links, bookmarks and
 * the wild, and a 404 is a worse answer than the page they wanted.
 */
export default function MarketsPage(): never {
  redirect("/explorer");
}
