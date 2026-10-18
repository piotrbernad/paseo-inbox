import { openExternalUrl } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Image, Pressable, type StyleProp, Text, type TextStyle, View } from "react-native";
import { imageSource, links, segments } from "./links.ts";
import type { Styles } from "./styles.ts";

function useOpen() {
  const toast = useToast();
  return (url: string) => {
    openExternalUrl(url).catch(() => toast.error(`Could not open ${url}`));
  };
}

// Text whose http(s) links open in the browser or the OS URL handler.
export function LinkedText(props: { text: string; style: StyleProp<TextStyle>; styles: Styles }) {
  const { text, style, styles } = props;
  const open = useOpen();
  return (
    <Text selectable style={style}>
      {segments(text).map((s, i) =>
        s.kind === "text" ? (
          s.text
        ) : (
          <Text key={i} accessibilityRole="link" onPress={() => open(s.url)} style={styles.link}>
            {s.url}
          </Text>
        ),
      )}
    </Text>
  );
}

// A preview of every image the text links to; tapping one opens the image itself.
export function ImagePreviews({ text, styles }: { text: string; styles: Styles }) {
  const images = links(text).flatMap((url) => {
    const source = imageSource(url);
    return source === null ? [] : [{ url, source }];
  });
  if (images.length === 0) return null;
  return (
    <View style={{ gap: styles.gap }}>
      {images.map((image) => (
        <ImagePreview key={image.url} {...image} styles={styles} />
      ))}
    </View>
  );
}

function ImagePreview({ url, source, styles }: { url: string; source: string; styles: Styles }) {
  const open = useOpen();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    Image.getSize(
      source,
      (width, height) => live && width > 0 && height > 0 && setSize({ width, height }),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [source]);
  if (failed) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open image ${url}`}
      onPress={() => open(source)}
      style={[styles.imageFrame, size && { maxWidth: Math.min(styles.imageFrame.maxWidth, size.width) }]}
    >
      <Image
        source={{ uri: source }}
        resizeMode="contain"
        onError={() => setFailed(true)}
        style={{ width: "100%", aspectRatio: size ? size.width / size.height : 16 / 9 }}
      />
    </Pressable>
  );
}
