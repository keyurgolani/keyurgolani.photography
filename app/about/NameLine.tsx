import React from 'react';

/** The artist's name, then the alias after a middle dot. */
export default function NameLine({ name, alias }: { name: string; alias?: string }) {
  return (
    <>
      {name}
      {alias ? <span> · {alias}</span> : null}
    </>
  );
}
