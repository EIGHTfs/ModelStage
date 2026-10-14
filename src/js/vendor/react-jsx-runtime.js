/**
 * @license React
 * react-jsx-runtime.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */var fb;function sT(){if(fb)return yc;fb=1;var n=Symbol.for("react.transitional.element"),t=Symbol.for("react.fragment");function a(s,l,c){var u=null;if(c!==void 0&&(u=""+c),l.key!==void 0&&(u=""+l.key),"key"in l){c={};for(var d in l)d!=="key"&&(c[d]=l[d])}else c=l;return l=c.ref,{$$typeof:n,type:s,key:u,ref:l!==void 0?l:null,props:c}}return yc.Fragment=t,yc.jsx=a,yc.jsxs=a,yc}var hb;function oT(){return hb||(hb=1,ym.exports=sT()),ym.exports}var v=oT(),vm={exports:{}},Re={};