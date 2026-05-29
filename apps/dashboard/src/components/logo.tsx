export function FreeLLMLogo({ size = 32 }: { size?: number }) {
  return (
    <img
      src="/logo.svg"
      width={size}
      height={size}
      alt="FreeLLM"
      className="rounded-md"
    />
  );
}
