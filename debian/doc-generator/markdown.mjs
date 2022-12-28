export const referenceToLocalMdFile = /^(?![+a-z]+:)([^#?]+)\.md(#.+)?$/i;

export function replaceLinks({ filename, linksMapper }) {
  const fileHtmlUrls = linksMapper[filename];
  return (token) => {
    if (token.type == "link") {
      token.href = token.href.replace(
        referenceToLocalMdFile,
        (_, filename, hash) => `${filename}.html${hash || ''}`
      );
    }


    /*
    visit(tree, (node) => {
      if (node.url) {
        node.url = node.url.replace(
          referenceToLocalMdFile,
          (_, filename, hash) => `${filename}.html${hash || ''}`
        );
      }
    });
    visit(tree, 'definition', (node) => {
      const htmlUrl = fileHtmlUrls && fileHtmlUrls[node.identifier];

      if (htmlUrl && typeof htmlUrl === 'string') {
        node.url = htmlUrl;
      }
    });
    */
  };
}
